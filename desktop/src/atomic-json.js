const {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');

function backupPathFor(filePath) {
  return `${filePath}.bak`;
}

function durableWrite(filePath, text) {
  const descriptor = openSync(filePath, 'wx');

  try {
    writeFileSync(descriptor, text, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(directory) {
  let descriptor;

  try {
    descriptor = openSync(directory, 'r');
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is unavailable on Windows and some network filesystems.
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function replacePath(sourcePath, destinationPath) {
  try {
    renameSync(sourcePath, destinationPath);
    return;
  } catch (error) {
    if (
      !existsSync(destinationPath) ||
      !['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)
    ) {
      throw error;
    }
  }

  const previousPath =
    `${destinationPath}.${process.pid}.${Date.now()}.` +
    `${Math.random().toString(16).slice(2)}.previous`;
  renameSync(destinationPath, previousPath);

  try {
    renameSync(sourcePath, destinationPath);
    rmSync(previousPath, { force: true, recursive: true });
  } catch (error) {
    if (!existsSync(destinationPath) && existsSync(previousPath)) {
      renameSync(previousPath, destinationPath);
    }

    throw error;
  }
}

function writeJsonAtomic(value, filePath, { keepBackup = true } = {}) {
  const directory = path.dirname(filePath);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporaryPath =
    `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  mkdirSync(directory, { recursive: true });

  try {
    durableWrite(temporaryPath, text);

    if (keepBackup && existsSync(filePath)) {
      const currentText = readFileSync(filePath, 'utf8');
      let currentIsValid = false;

      try {
        JSON.parse(currentText);
        currentIsValid = true;
      } catch {
        // Never replace a previous-good backup with corrupt primary data.
      }

      if (currentIsValid) {
        const backupPath = backupPathFor(filePath);
        const backupTemporaryPath =
          `${backupPath}.${process.pid}.${Date.now()}.tmp`;

        try {
          durableWrite(backupTemporaryPath, currentText);
          replacePath(backupTemporaryPath, backupPath);
        } finally {
          rmSync(backupTemporaryPath, { force: true });
        }
      }
    }

    replacePath(temporaryPath, filePath);
    syncDirectory(directory);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function parseValidated(filePath, validate) {
  return validate(JSON.parse(readFileSync(filePath, 'utf8')));
}

function readJsonRecovering(
  filePath,
  { fallback, validate = (value) => value } = {},
) {
  try {
    return parseValidated(filePath, validate);
  } catch (primaryError) {
    try {
      const recovered = parseValidated(backupPathFor(filePath), validate);
      writeJsonAtomic(recovered, filePath, { keepBackup: false });
      return recovered;
    } catch {
      if (fallback !== undefined) {
        return typeof fallback === 'function' ? fallback() : fallback;
      }

      throw primaryError;
    }
  }
}

module.exports = {
  backupPathFor,
  readJsonRecovering,
  replacePath,
  writeJsonAtomic,
};
