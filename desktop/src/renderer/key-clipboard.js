const { actionPageTargets } = require('../action-model');

function clone(value) {
  return structuredClone(value);
}

function keyPayload(key) {
  if (!key) {
    return null;
  }

  const { index: _index, ...payload } = key;
  return clone(payload);
}

function validatePageTarget(payload, pageCount) {
  for (const page of actionPageTargets(payload?.action)) {
    if (!Number.isInteger(page) || page < 0 || page >= pageCount) {
      throw new RangeError(
        'This key targets a page that does not exist in the destination profile.',
      );
    }
  }
}

function rewriteKey(payload, index, pageCount) {
  validatePageTarget(payload, pageCount);
  return { index, ...clone(payload) };
}

function pasteKey(keys, index, payload, pageCount) {
  const next = keys.filter((key) => key.index !== index);

  if (payload && Object.keys(payload).length > 0) {
    next.push(rewriteKey(payload, index, pageCount));
  }

  return next.sort((left, right) => left.index - right.index);
}

function moveKey({
  sourceKeys,
  sourceIndex,
  sourcePageCount,
  destinationKeys,
  destinationIndex,
  destinationPageCount,
  samePage = false,
}) {
  const source = sourceKeys.find((key) => key.index === sourceIndex);

  if (!source) {
    throw new Error('The dragged key no longer exists.');
  }

  const destination = destinationKeys.find(
    (key) => key.index === destinationIndex,
  );
  const sourcePayload = keyPayload(source);
  const destinationPayload = keyPayload(destination);
  validatePageTarget(sourcePayload, destinationPageCount);

  if (destinationPayload) {
    validatePageTarget(destinationPayload, sourcePageCount);
  }

  if (samePage) {
    let keys = sourceKeys.filter(
      (key) => key.index !== sourceIndex && key.index !== destinationIndex,
    );
    keys = pasteKey(keys, destinationIndex, sourcePayload, destinationPageCount);

    if (destinationPayload) {
      keys = pasteKey(keys, sourceIndex, destinationPayload, sourcePageCount);
    }

    return { sourceKeys: keys, destinationKeys: keys };
  }

  let nextSource = sourceKeys.filter((key) => key.index !== sourceIndex);
  let nextDestination = destinationKeys.filter(
    (key) => key.index !== destinationIndex,
  );
  nextDestination = pasteKey(
    nextDestination,
    destinationIndex,
    sourcePayload,
    destinationPageCount,
  );

  if (destinationPayload) {
    nextSource = pasteKey(
      nextSource,
      sourceIndex,
      destinationPayload,
      sourcePageCount,
    );
  }

  return {
    sourceKeys: nextSource,
    destinationKeys: nextDestination,
  };
}

function isEditableTarget(target) {
  return Boolean(
    target?.isContentEditable ||
    ['INPUT', 'SELECT', 'TEXTAREA'].includes(target?.tagName),
  );
}

module.exports = {
  isEditableTarget,
  keyPayload,
  moveKey,
  pasteKey,
  rewriteKey,
  validatePageTarget,
};
