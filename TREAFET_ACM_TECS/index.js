// const TaskGenerator = require('./TaskGenerator');
// const BenchmarkSuites = require('./BenchmarkSuites');



const FINFET_PARAMS = {
    d0: -4.27,
    d1: 0.0042,
    d2: 0.0052,
    d3: 10.6,
    d4: -2.66,
    C_die: 9.0,         // J/K (Thermal Capacitance)
    R_die_amb: 35.8,    // K/W (Thermal Resistance)
    Temp_amb: 40.0,     // °C (Ambient Temperature)
    K_dyn: 15.0,
    Temp_thr_Hi: 80.0,  // °C
    Temp_thr_Low: 77.0, // °C
    V_dd_levels: [0.65, 0.70, 0.75, 0.80, 0.85], // Volts [V_dd[1] ... V_dd[L]]
    VR_Speed: 0.02,     // V/ns (20mV/ns)
    Stall_Span: 70,     // ns (DRAM access latency)
    Break_Even_Time: 5  // ms (Core power gating break-even time)
};

class FinFETPhysics {

    static getFrequency(Vdd, Temp) {
        const { d0, d1, d2, d3, d4 } = FINFET_PARAMS;
        const freq = d0 * Math.pow(Vdd, 2) + d1 * Vdd * Temp + d2 * Temp + d3 * Vdd + d4;
        return Math.max(0.1, freq); // Return normalized frequency
    }

    static getDynamicPower(Vdd, Freq) {
        return FINFET_PARAMS.K_dyn * Math.pow(Vdd, 2) * Freq;
    }

    static getLeakagePower(Vdd, Temp) {
        const c1 = 0.0001, c2 = 0.01, c3 = -100, c4 = 0.005, c5 = 1.2, c6 = -0.5;
        const term1 = c1 * Math.pow(Temp, 2) * Math.exp((c2 * Vdd + c3) / Temp);
        const term2 = c4 * Math.exp(c5 * Vdd + c6);
        return Vdd * (term1 + term2);
    }

    static getTotalPower(Vdd, Temp, Freq) {
        return this.getDynamicPower(Vdd, Freq) + this.getLeakagePower(Vdd, Temp);
    }

    static predictTemperature(currentTemp, Vdd, Freq, dtInSeconds) {
        const totalPower = this.getTotalPower(Vdd, currentTemp, Freq);
        const dTemp_dt = (totalPower - (currentTemp - FINFET_PARAMS.Temp_amb) / FINFET_PARAMS.R_die_amb) / FINFET_PARAMS.C_die;
        return currentTemp + dTemp_dt * dtInSeconds;
    }
}

class Task {
    constructor(id, executionReq, period) {
        this.id = id;
        this.e = executionReq;  // Execution requirement on normalized F_max
        this.d = period;        // Deadline / Period
        this.rd = period;       // Remaining deadline
        this.utilization = executionReq / period;
    }
}

class Core {
    constructor(id, initialTemp = 45.0) {
        this.id = id;
        this.temp = initialTemp;
        this.capacity = 0;
        this.isPoweredOn = true;
        this.assignedTasks = [];
        this.baseFreq = 1.0;
    }
}

class TREAFETScheduler {
    constructor(tasks, cores, frameDelta = 1) {
        this.tasks = tasks;
        this.cores = cores;
        this.delta = frameDelta; // Maximum frame size Δ for DTM monitoring
        this.scheduleTable = {};
    }

    runScheduler() {
        const intervalLen = Math.min(...this.tasks.map(t => t.rd));
        const avgCoreTemp = this.cores.reduce((sum, c) => sum + c.temp, 0) / this.cores.length;
        let taskListA1 = [];
        for (let task of this.tasks) {
            const er_k = Math.ceil((task.e * intervalLen) / task.d); // Eq. 7
            const projTemp = FinFETPhysics.predictTemperature(
                avgCoreTemp,
                FINFET_PARAMS.V_dd_levels[2], // Nominal Vdd = 0.75V
                1.0,
                er_k / 1000.0
            );

            taskListA1.push({ task, er_k, projTemp });
        }
        taskListA1.sort((a, b) => b.projTemp - a.projTemp);
        this.scheduleInterval(taskListA1, intervalLen);
    }

    scheduleInterval(taskListA1, intervalLen) {
        let A_mgr = []; // Task migration list
        let flag = 1;
        this.cores.forEach(core => {
            core.capacity = intervalLen;
            core.assignedTasks = [];
        });

        let sortedCores = [...this.cores].sort((a, b) => b.temp - a.temp);

        while (taskListA1.length > 0) {
            let taskObj;
            let targetCore = null;

            if (flag === 1) {
                taskObj = taskListA1.shift();
                targetCore = [...sortedCores].reverse().find(c => c.capacity >= taskObj.er_k);
                if (!targetCore) {
                    A_mgr.unshift(taskObj);
                    continue;
                }
            } else {
                taskObj = taskListA1.pop();
                targetCore = sortedCores.find(c => c.capacity >= taskObj.er_k);
                if (!targetCore) {
                    A_mgr.push(taskObj);
                    continue;
                }
            }

            targetCore.assignedTasks.push(taskObj);
            targetCore.capacity -= taskObj.er_k;

            targetCore.temp = FinFETPhysics.predictTemperature(
                targetCore.temp,
                FINFET_PARAMS.V_dd_levels[2],
                1.0,
                taskObj.er_k / 1000.0
            );
            sortedCores.sort((a, b) => b.temp - a.temp);

            flag = (flag + 1) % 2;
        }

        A_mgr.forEach(taskObj => {
            let core = this.cores.find(c => c.capacity >= taskObj.er_k) || this.cores[0];
            core.assignedTasks.push(taskObj);
            core.capacity = Math.max(0, core.capacity - taskObj.er_k);
        });

        this.cores.forEach(core => {
            const assignedWorkload = core.assignedTasks.reduce((sum, item) => sum + item.er_k, 0);
            core.baseFreq = Math.min(1.0, assignedWorkload / intervalLen);
            core.assignedTasks.forEach(item => {
                this.runtimeThermalManagement(core, item.task, item.er_k, core.baseFreq);
            });
        });
    }


    runtimeThermalManagement(core, task, executionShare, baseFreq) {
        let re_k = executionShare;
        let cycle_cntr = 0;
        let Vin = FINFET_PARAMS.V_dd_levels[2]; // Default 0.75V

        while (re_k > 0) {
            const frameSpan = Math.min(this.delta, re_k);

            if (cycle_cntr === frameSpan) {
                // Evaluate frame-boundary dynamic voltage scaling based on TEI
                if (core.temp >= FINFET_PARAMS.Temp_thr_Hi) {
                    Vin = FINFET_PARAMS.V_dd_levels[0]; // Scale to lowest Vdd [0.65V]
                } else if (core.temp <= FINFET_PARAMS.Temp_thr_Low) {
                    Vin = FINFET_PARAMS.V_dd_levels[FINFET_PARAMS.V_dd_levels.length - 1]; // Highest Vdd [0.85V]
                } else {
                    // Find lowest voltage maintaining base frequency requirement
                    for (let p = 1; p < FINFET_PARAMS.V_dd_levels.length - 1; p++) {
                        let F_curr = FinFETPhysics.getFrequency(Vin, core.temp);
                        let F_next = FinFETPhysics.getFrequency(FINFET_PARAMS.V_dd_levels[p], core.temp);
                        if ((F_curr + F_next) / 2.0 >= baseFreq) {
                            Vin = FINFET_PARAMS.V_dd_levels[p];
                            break;
                        }
                    }
                }

                cycle_cntr = 0;
                re_k -= frameSpan;
            } else {
                cycle_cntr++;
                let F_curr = FinFETPhysics.getFrequency(Vin, core.temp);

                const isLLCMiss = Math.random() < 0.15; // 15% probability of LLC miss
                if (isLLCMiss) {
                    cycle_cntr += this.energyAdaptiveDVFS(core, F_curr, Vin);
                }
                core.temp = FinFETPhysics.predictTemperature(core.temp, Vin, F_curr, 0.001);

                // Evaluate slack exploitation for power gating (Algorithm 5)
                this.slackExploitation(core, re_k);
            }
        }
    }

    energyAdaptiveDVFS(core, F_curr, V_in) {
        const v_L = FINFET_PARAMS.V_dd_levels[0];     // 0.65V
        const v_Tur = FINFET_PARAMS.V_dd_levels[4];   // 0.85V

        // Voltage transition cycle calculation
        const t_sw = Math.ceil(((V_in - v_L) / FINFET_PARAMS.VR_Speed) * F_curr);
        const t_L = Math.max(0, FINFET_PARAMS.Stall_Span - 2 * t_sw);

        // Compute energy savings during stall and determine Turbo time span (t_Tur)
        const E_sav = FinFETPhysics.getDynamicPower(V_in, F_curr) - FinFETPhysics.getDynamicPower(v_L, FinFETPhysics.getFrequency(v_L, core.temp));
        const P_tur = FinFETPhysics.getDynamicPower(v_Tur, FinFETPhysics.getFrequency(v_Tur, core.temp));
        const t_Tur = Math.max(0, Math.floor(E_sav / (P_tur || 1)));

        // Return bonus cycles gained through turbo frequency acceleration
        const gainedCycles = Math.floor(t_Tur * (FinFETPhysics.getFrequency(v_Tur, core.temp) - F_curr));
        return Math.max(0, gainedCycles);
    }

    slackExploitation(core, slackAfterTask) {
        if (slackAfterTask > FINFET_PARAMS.Break_Even_Time) {
            // Power-gate the core to save power and cool down
            core.isPoweredOn = false;

            // Cooldown during idle break-even interval
            core.temp = Math.max(
                FINFET_PARAMS.Temp_amb,
                core.temp - (core.temp - FINFET_PARAMS.Temp_amb) * 0.05
            );

            core.isPoweredOn = true; // Turn back ON when slack expires
        }
    }
}

(function runTREAFETDemo() {
    console.log("=== TREAFET Scheduler Simulation ===");

    // Initialize 4 Cores (Table 4)
    const cores = [
        new Core(0, 50.0),
        new Core(1, 55.0),
        new Core(2, 48.0),
        new Core(3, 52.0)
    ];

    // Create Sample Task Set (Table 2 / Table 5)
    const tasks = [
        new Task(1, 20, 100),
        new Task(2, 40, 100),
        new Task(3, 30, 150),
        new Task(4, 60, 150)
    ];

    const scheduler = new TREAFETScheduler(tasks, cores, 1.0);

    console.log("\nInitial Core Temperatures:");
    cores.forEach(c => console.log(` - Core ${c.id}: ${c.temp.toFixed(2)} °C`));

    console.log("\nExecuting TREAFET Scheduling & Thermal Management...");
    scheduler.runScheduler();

    console.log("\nPost-Execution Core Status:");
    cores.forEach(c => {
        console.log(
            ` - Core ${c.id}: Temp = ${c.temp.toFixed(2)} °C | Base Operating Freq = ${c.baseFreq.toFixed(2)} | Tasks Assigned = ${c.assignedTasks.length}`
        );
    });
})();

// function loadInputConfiguration() {
//     const args = process.argv.slice(2);
//
//     // 1. JSON file input: `node scheduler.js config.json`
//     if (args[0] && fs.existsSync(args[0])) {
//         console.log(`[Input] Loading input from JSON file: ${args[0]}`);
//         const rawData = fs.readFileSync(args[0]);
//         const parsed = JSON.parse(rawData);
//
//         const cores = parsed.cores.map(c => new Core(c.id, c.initialTemp));
//         const tasks = parsed.tasks.map(t => new Task(t.id, t.executionReq, t.period));
//         return { cores, tasks, delta: parsed.delta || 1.0 };
//     }
//
//     // 2. Synthetic generation flag: `node scheduler.js --synthetic <numTasks> <totalUtil> <numCores>`
//     if (args[0] === '--synthetic') {
//         const numTasks = parseInt(args[1]) || 8;
//         const totalUtil = parseFloat(args[2]) || 2.0;
//         const numCores = parseInt(args[3]) || 4;
//
//         console.log(`[Input] Generating Synthetic Input: ${numTasks} tasks, Utilization = ${totalUtil}, ${numCores} cores`);
//         return {
//             cores: TaskGenerator.generateCores(numCores, 40, 75),
//             tasks: TaskGenerator.generateTaskSet(numTasks, totalUtil),
//             delta: 1.0
//         };
//     }
//
//     // 3. Fallback to Thermal Stress Benchmark
//     console.log("[Input] No external file provided. Loading default THERMAL_STRESS benchmark.");
//     return {
//         cores: BenchmarkSuites.THERMAL_STRESS.cores,
//         tasks: BenchmarkSuites.THERMAL_STRESS.tasks,
//         delta: 1.0
//     };
// }
//
// // ============================================================================
// // EXECUTION WITH DYNAMIC INPUT
// // ============================================================================
// (function run() {
//     const { cores, tasks, delta } = loadInputConfiguration();
//
//     console.log("\n--- Cores Input ---");
//     cores.forEach(c => console.log(`Core ${c.id}: Initial Temp = ${c.temp} °C`));
//
//     console.log("\n--- Tasks Input ---");
//     tasks.forEach(t => console.log(`Task ${t.id}: e = ${t.e} ms, d = ${t.d} ms, Util = ${t.utilization.toFixed(2)}`));
//
//     const scheduler = new TREAFETScheduler(tasks, cores, delta);
//     scheduler.runScheduler();
// })();