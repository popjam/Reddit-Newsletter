import cliProgress from 'cli-progress';

console.log("Testing progress bar...");

const progressBar = new cliProgress.SingleBar({
    format: 'Progress |{bar}| {percentage}% | {current}/{subredditCount} | {statusMessage}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
    stopOnComplete: true,
    clearOnComplete: false
});

console.log("Progress bar created, starting...");

progressBar.start(10, 0, {
    current: 0,
    subredditCount: 10,
    statusMessage: 'Testing...'
});

console.log("Progress bar started!");

// Update it a few times
for (let i = 1; i <= 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    progressBar.update(i, {
        current: i,
        subredditCount: 10,
        statusMessage: `Processing ${i}/10`
    });
}

progressBar.stop();
console.log("Test complete!");