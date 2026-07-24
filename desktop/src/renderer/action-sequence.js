class ActionSequenceCancelledError extends Error {
  constructor(step) {
    super(`Multi action canceled before step ${step}.`);
    this.name = 'ActionSequenceCancelledError';
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runActionSequence(
  steps,
  {
    runLeaf,
    switchPage,
    switchProfile,
    sleep = defaultSleep,
    isCancelled = () => false,
  },
) {
  for (const [index, step] of steps.entries()) {
    const stepNumber = index + 1;

    if (isCancelled()) {
      throw new ActionSequenceCancelledError(stepNumber);
    }

    try {
      if (step.type === 'delay') {
        await sleep(step.ms);
      } else if (step.type === 'page') {
        await switchPage(step.page);
      } else if (step.type === 'profile') {
        await switchProfile(step.profileId);
      } else {
        await runLeaf(step);
      }
    } catch (error) {
      if (error instanceof ActionSequenceCancelledError) {
        throw error;
      }

      throw new Error(
        `Multi action step ${stepNumber} failed: ${error.message}`,
        { cause: error },
      );
    }

    if (index < steps.length - 1 && isCancelled()) {
      throw new ActionSequenceCancelledError(stepNumber + 1);
    }
  }
}

module.exports = {
  ActionSequenceCancelledError,
  runActionSequence,
};
