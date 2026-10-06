let tasks = [
    {e: 4, p: 20, t: 1, a: 0, execute: 0, remaining: 4, deadline: 20},
    {e: 6, p: 25, t: 2, a: 0, execute: 0, remaining: 6, deadline: 25},
    {e: 7, p: 15, t: 3, a: 0, execute: 0, remaining: 7, deadline: 15},
    {e: 6, p: 30, t: 4, a: 0, execute: 0, remaining: 6, deadline: 30}
]
let numberOfProcessor = 2

const sortTask = async (tasksList) => {
    let sortedTasksByDeadling = tasksList.sort(function (a, b) {
        return a.deadline - b.deadline;
    });
    return sortedTasksByDeadling;
}

let scheduledTasks = []
const getTasksHyperWindow = async (arrayOfObject) => {
    const input_array = arrayOfObject.map(data => {
        return data.p
    })
    var r1 = 0, r2 = 0;
    var l = input_array.length;
    for (i = 0; i < l; i++) {
        r1 = input_array[i] % input_array[i + 1];
        if (r1 === 0) {
            input_array[i + 1] = (input_array[i] * input_array[i + 1]) / input_array[i + 1];
        } else {
            r2 = input_array[i + 1] % r1;
            if (r2 === 0) {
                input_array[i + 1] = (input_array[i] * input_array[i + 1]) / r1;
            } else {
                input_array[i + 1] = (input_array[i] * input_array[i + 1]) / r2;
            }
        }
    }
    return input_array[l - 1];
}

const getTasksShareInGivenTimeSlice = async (tasksList, deadline, periodStart) => {

    let dataToSend = []

    for (let task in tasksList) {
        let data = Object.assign({}, tasksList[task])
        let timeShare = Math.ceil(((data.remaining * (deadline - periodStart)) / (data.deadline - periodStart)))
        data.timeShare = timeShare
        data.remaining = data.remaining - timeShare
        data.execute = data.execute + timeShare
        dataToSend.push(data)
    }
    return dataToSend
}

const allotProcessors = async (tasksList, deadLine ,isFre = 0) => {
    let processorsCount = numberOfProcessor
    let deadLineOfEachProcessors = deadLine
    let dataToPush = []
    let totalTimeForOneProcessor = deadLine
    let totalTimeYetInOneProcessor = 0

    tasksList = await frequencyRequirement(tasksList,deadLine)

    for (let data in tasksList) {
        let task = Object.assign({}, tasksList[data])
        task.processor = numberOfProcessor - processorsCount + 1
        task.timeWindow = deadLine
        deadLineOfEachProcessors = deadLineOfEachProcessors - task.timeShare
        totalTimeForOneProcessor = totalTimeForOneProcessor - task.timeShare
        totalTimeYetInOneProcessor = totalTimeYetInOneProcessor + task.timeShare
        task.processorExecution = totalTimeForOneProcessor > 0 ? task.timeShare : deadLine - totalTimeYetInOneProcessor
        dataToPush.push(task)

        if (deadLineOfEachProcessors <= 0) {
            let taskRemainingOfOldProcessor = deadLineOfEachProcessors
            deadLineOfEachProcessors = deadLine + deadLineOfEachProcessors
            processorsCount--;
            totalTimeYetInOneProcessor = 0
            if (deadLine > deadLineOfEachProcessors) {
                let migratingTask = Object.assign({}, tasksList[data])
                migratingTask.processor = numberOfProcessor - processorsCount + 1
                migratingTask.timeWindow = deadLine
                deadLineOfEachProcessors = taskRemainingOfOldProcessor * -1
                totalTimeForOneProcessor = deadLineOfEachProcessors;
                totalTimeYetInOneProcessor = deadLineOfEachProcessors;
                migratingTask.processorExecution = deadLineOfEachProcessors
                dataToPush.push(migratingTask)
            }
        }
    }
    scheduledTasks.push(dataToPush)
}

const changeDeadlineForCompliteTasks = async (taskShare, timeWindow) => {

    let dataToSend = []
    for (let i = 0; i < taskShare.length; i++) {
        let task = Object.assign({}, taskShare[i])
        if (task.deadline == timeWindow) {
            task.deadline = task.deadline + task.p
            task.remaining = task.e
            task.execute = 0
        }
        dataToSend.push(task)
    }
    return dataToSend
}

const nextDeadline = async (taskShare, deadline) => {

    let comingDeadline = 0
    for (let i = 0; i < taskShare.length; i++) {
        if (taskShare[i].remaining == 0) {
            continue;
        }
        comingDeadline = taskShare[i].p - deadline
        break;
    }
    return comingDeadline;
}

const getNearestFrequency = async (frequencyRequired) => {
    let availableFrequency = [0.78, 0.79, 0.8, 0.81, 0.84, 0.85, 0.86, 0.88, 0.9, 0.92, 0.93, 0.94, 0.96, 0.97, 0.98,1.0]

}
const frequencyRequirement = async (originalTaskSchedule,deadline) => {

    let totalShare = originalTaskSchedule.map(data => {
        return data.timeShare
    })
    let sum = totalShare.reduce((partial_sum, a) => partial_sum + a, 0)
    let frequencyRequired = sum / (numberOfProcessor * deadline)
    frequencyRequired = frequencyRequired.toFixed(2);
    let nearestFrequency = await getNearestFrequency(frequencyRequired)
    let newTaskScheduleList = originalTaskSchedule
    for (let index in newTaskScheduleList)
    {
        newTaskScheduleList[index].newShare = Math.ceil(newTaskScheduleList[index].timeShare/frequencyRequired)
        newTaskScheduleList[index].frequencyToRun = frequencyRequired
    }
    let newShare = originalTaskSchedule.map(data => {
        return data.newShare
    })
    sum = newShare.reduce((partial_sum, a) => partial_sum + a, 0)
    let sortedTaskScheduleList = newTaskScheduleList
    while(sum > (numberOfProcessor * deadline))
    {
         sortedTaskScheduleList = sortedTaskScheduleList.sort(function (a, b) {
            return b.newShare - a.newShare;
        });
         let isFrequencyChange = 0;
        for (let index in sortedTaskScheduleList) {
            if(sortedTaskScheduleList[index].frequencyToRun == 1)
            {
                continue;
            }
            sortedTaskScheduleList[index].newShare = sortedTaskScheduleList[0].timeShare
            sortedTaskScheduleList[index].frequencyToRun = 1
            isFrequencyChange = 1
            break;
        }
        if(isFrequencyChange==0)
        {
            return sortedTaskScheduleList;
        }
        let newShare = sortedTaskScheduleList.map(data => {
            return data.newShare
        })
        sum = newShare.reduce((partial_sum, a) => partial_sum + a, 0)
    }

    for(let i =0 ;i < sortedTaskScheduleList.length; i++)
    {
        sortedTaskScheduleList[i].oldShare = sortedTaskScheduleList[i].timeShare
        sortedTaskScheduleList[i].timeShare = sortedTaskScheduleList[i].newShare
    }
    return sortedTaskScheduleList
}

const scheduledTaskList = async () => {
    let maxPeriodOfRepeatTasks = await getTasksHyperWindow(tasks)
    let sortedTasksByDeadling = await sortTask(tasks)
    let deadline = sortedTasksByDeadling[0].deadline;
    let taskShare = sortedTasksByDeadling
    let periodStart = 0;
    while (periodStart <= 16) {
        taskShare = await getTasksShareInGivenTimeSlice(taskShare, deadline, periodStart)
        await allotProcessors(taskShare, deadline)
        periodStart = deadline
        taskShare = await changeDeadlineForCompliteTasks(taskShare, periodStart)
        sortedTasksByDeadling = await sortTask(taskShare)
        deadline = sortedTasksByDeadling[0].deadline;
    }
    console.log("scc", JSON.stringify(scheduledTasks))
}

scheduledTaskList();