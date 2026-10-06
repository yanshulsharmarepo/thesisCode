const fs = require("fs");
const path = require("path");

const folderPath = path.join(__dirname, "Set1");

const files = fs.readdirSync(folderPath);

const results = [];

function getData() {
    for (const file of files) {
        if (!file.endsWith(".txt")) continue;

        // Extract filename parameters
        const match = file.match(
            /Set_(\d+)_m_(\d+)_U_(\d+)_n_(\d+)/i
        );

        if (!match) continue;

        const set = Number(match[1]);
        const m = Number(match[2]);
        const U = Number(match[3]);
        const n = Number(match[4]);

        // Read file content
        const filePath = path.join(folderPath, file);
        const content = fs.readFileSync(filePath, "utf8");

        // Process each line
        const rows = content
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .map(line => {
                const values = line.trim().split(/\s+/).map(Number);

                return {
                    t: values[0],
                    values: values.slice(1)
                };
            });

        results.push({
            filename: file,
            set,
            m,
            U,
            n,
            rows
        });
        console.log(JSON.stringify({
            filename: file,
            set,
            m,
            U,
            n,
            rows
        }));
    }
    return results;
}
module.exports = { getData };
