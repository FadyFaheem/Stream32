const { ESPLoader, Transport } = require('esptool-js');
const { calculateFirmwareMd5 } = require('./firmware-hash');
const {
  createLineDecoder,
  encodeHostHello,
  isExpectedChip,
  validateDeviceHello,
  validateTouchMessage,
} = require('./protocol');

const HANDSHAKE_TIMEOUT_MS = 7000;
const HELLO_RETRY_MS = 1000;
const RECONNECT_ATTEMPTS = 8;
const RECONNECT_DELAY_MS = 750;
const MAX_LOG_LINES = 80;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error) {
  if (error?.name === 'NotFoundError') {
    return 'No ESP32-S3 was selected.';
  }

  if (error?.name === 'NetworkError') {
    return (
      'The serial port is busy or the board was disconnected.' +
      (error.message ? ` (${error.message})` : '')
    );
  }

  return error instanceof Error ? error.message : String(error);
}

class DeviceController {
  constructor({ api, document, serial }) {
    this.api = api;
    this.document = document;
    this.serial = serial;
    this.boards = new Map();
    this.busy = false;
    this.logLines = [];
    this.operation = null;
    this.selectedPort = null;
    this.selectedPortBoardId = null;
    this.session = null;

    this.boardSelect = document.querySelector('#board-select');
    this.boardDetails = document.querySelector('#board-details');
    this.catalogStatus = document.querySelector('#catalog-status');
    this.chooseUsbButton = document.querySelector('#choose-usb');
    this.confirmRevision = document.querySelector('#confirm-revision');
    this.confirmationBoard = document.querySelector('#confirmation-board');
    this.deviceStatus = document.querySelector('#device-status');
    this.firmwareVersion = document.querySelector('#firmware-version');
    this.flashButton = document.querySelector('#flash-device');
    this.flashLog = document.querySelector('#flash-log');
    this.flashProgress = document.querySelector('#flash-progress');
    this.flashStatus = document.querySelector('#flash-status');
    this.reconnectButton = document.querySelector('#reconnect-device');
    this.recoveryList = document.querySelector('#recovery-steps');
    this.refreshButton = document.querySelector('#refresh-boards');
    this.refreshUsbButton = document.querySelector('#refresh-usb');
    this.touchStatus = document.querySelector('#touch-status');
    this.usbPortStatus = document.querySelector('#usb-port-status');
  }

  async initialize() {
    this.boardSelect.addEventListener('change', () => {
      this.confirmRevision.checked = false;
      this.clearUsbSelection();
      this.updateSelectedBoard();
    });
    this.chooseUsbButton.addEventListener('click', () => {
      this.selectUsbPort();
    });
    this.refreshUsbButton.addEventListener('click', () => {
      this.selectUsbPort();
    });
    this.confirmRevision.addEventListener('change', () =>
      this.updateFlashButton(),
    );
    this.flashButton.addEventListener('click', () => {
      this.flashSelectedBoard();
    });
    this.refreshButton.addEventListener('click', () => {
      this.loadBoards(true);
    });
    this.reconnectButton.addEventListener('click', () => {
      this.reconnectAuthorizedDevice();
    });

    this.api.onBoardDownloadProgress((progress) => {
      const selected = this.selectedBoard();

      if (!selected || progress.boardId !== selected.id || this.busy === false) {
        return;
      }

      const percent = progress.total
        ? Math.round((progress.received / progress.total) * 100)
        : 0;
      this.setProgress(percent);
      this.flashStatus.textContent = progress.cached
        ? 'Using verified cached firmware…'
        : `Downloading firmware… ${percent}%`;
    });

    if (!this.serial) {
      this.setDeviceStatus(
        'Web Serial is unavailable in this Electron build.',
        'error',
      );
      this.flashButton.disabled = true;
      this.chooseUsbButton.disabled = true;
      this.refreshUsbButton.disabled = true;
      this.reconnectButton.disabled = true;
      return;
    }

    this.serial.addEventListener('connect', () => {
      if (!this.session && !this.operation) {
        this.reconnectAuthorizedDevice();
      }
    });
    this.serial.addEventListener('disconnect', (event) => {
      if (this.selectedPort === event.target && !this.busy) {
        this.clearUsbSelection('The selected USB/COM port was disconnected.');
      }

      if (this.session?.port === event.target) {
        this.closeSession();
        this.setDeviceStatus('Stream32 device disconnected.', 'idle');
      }
    });

    await this.loadBoards();
    await this.restoreUsbSelection();
    await this.reconnectAuthorizedDevice();
  }

  async restoreUsbSelection() {
    const board = this.selectedBoard();

    if (!board || this.selectedPort || !this.serial) {
      return;
    }

    try {
      const ports = await this.serial.getPorts();

      // ponytail: with several authorized ports there is no way to know which
      // one the user means, so only restore an unambiguous single grant.
      if (ports.length === 1) {
        this.selectedPort = ports[0];
        this.selectedPortBoardId = board.id;
        this.usbPortStatus.textContent =
          'Previously authorized USB port restored.';
        this.usbPortStatus.dataset.state = 'ready';
        this.updateFlashButton();
      }
    } catch {
      // Restoring a previous selection must never block startup.
    }
  }

  selectedBoard() {
    return this.boards.get(this.boardSelect.value) || null;
  }

  beginOperation(operation) {
    if (this.operation) {
      return false;
    }

    this.operation = operation;
    this.busy = operation === 'flash';
    this.boardSelect.disabled = true;
    this.chooseUsbButton.disabled = true;
    this.refreshUsbButton.disabled = true;
    this.refreshButton.disabled = true;
    this.reconnectButton.disabled = true;
    this.confirmRevision.disabled = true;
    this.updateFlashButton();
    return true;
  }

  endOperation(operation) {
    if (this.operation !== operation) {
      return;
    }

    this.operation = null;
    this.busy = false;
    this.boardSelect.disabled = false;
    this.chooseUsbButton.disabled =
      !this.serial || !this.selectedBoard();
    this.refreshUsbButton.disabled =
      !this.serial || !this.selectedBoard();
    this.refreshButton.disabled = false;
    this.reconnectButton.disabled = !this.serial;
    this.confirmRevision.disabled = false;
    this.updateFlashButton();
  }

  setProgress(value) {
    this.flashProgress.value = Math.max(0, Math.min(100, value));
  }

  clearUsbSelection(message = 'No USB or COM port selected.') {
    this.selectedPort = null;
    this.selectedPortBoardId = null;
    this.usbPortStatus.textContent = message;
    this.usbPortStatus.dataset.state = 'idle';
    this.updateFlashButton();
  }

  async selectUsbPort() {
    const board = this.selectedBoard();

    if (
      !board ||
      !this.serial ||
      !this.beginOperation('usb-select')
    ) {
      return;
    }

    try {
      // requestPort must run directly from this click before user activation
      // expires; downloading firmware first prevents Chromium's picker.
      const port = await this.serial.requestPort();
      await this.closeSession();
      await sleep(300);
      const info = port.getInfo();
      const vendorId = info.usbVendorId
        ?.toString(16)
        .padStart(4, '0');
      const productId = info.usbProductId
        ?.toString(16)
        .padStart(4, '0');
      const usbId =
        vendorId && productId ? ` · USB ${vendorId}:${productId}` : '';

      this.selectedPort = port;
      this.selectedPortBoardId = board.id;
      this.usbPortStatus.textContent = `Serial port selected${usbId}`;
      this.usbPortStatus.dataset.state = 'ready';
    } catch (error) {
      this.clearUsbSelection(
        error?.name === 'NotFoundError'
          ? 'USB/COM selection cancelled.'
          : `Could not select USB/COM: ${errorMessage(error)}`,
      );
    } finally {
      this.endOperation('usb-select');
    }
  }

  setDeviceStatus(message, state) {
    this.deviceStatus.textContent = message;
    this.deviceStatus.dataset.state = state;
  }

  appendLog(message) {
    const lines = String(message)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    this.logLines.push(...lines);
    this.logLines = this.logLines.slice(-MAX_LOG_LINES);
    this.flashLog.textContent = this.logLines.join('\n');
    this.flashLog.scrollTop = this.flashLog.scrollHeight;
  }

  clearLog() {
    this.logLines = [];
    this.flashLog.textContent = '';
  }

  async loadBoards(force = false) {
    if (!this.beginOperation('catalog')) {
      return;
    }

    this.confirmRevision.checked = false;
    this.catalogStatus.textContent = force
      ? 'Refreshing board support…'
      : 'Loading board support…';

    try {
      const result = await this.api.listBoards(force);
      const previousSelection = this.boardSelect.value;

      this.boards = new Map(result.boards.map((board) => [board.id, board]));
      this.boardSelect.replaceChildren();

      for (const board of result.boards) {
        const option = this.document.createElement('option');
        option.value = board.id;
        option.disabled = !board.compatible;
        option.textContent =
          `${board.name} Rev ${board.hardwareRevision}` +
          (board.compatible ? '' : ' — desktop update required');
        this.boardSelect.append(option);
      }

      if (this.boards.has(previousSelection)) {
        this.boardSelect.value = previousSelection;
      }

      if (
        this.selectedPortBoardId &&
        this.selectedPortBoardId !== this.boardSelect.value
      ) {
        this.clearUsbSelection();
      }

      this.catalogStatus.textContent = result.warning
        ? result.warning
        : result.source === 'cache'
          ? 'Board support loaded from the verified local cache.'
          : 'Board support is current.';
      this.catalogStatus.dataset.state = result.warning ? 'warning' : 'ready';
      this.updateSelectedBoard();
    } catch (error) {
      this.boards.clear();
      this.boardSelect.replaceChildren();
      this.clearUsbSelection();
      this.catalogStatus.textContent = errorMessage(error);
      this.catalogStatus.dataset.state = 'error';
      this.updateSelectedBoard();
    } finally {
      this.endOperation('catalog');
    }
  }

  updateSelectedBoard() {
    const board = this.selectedBoard();

    if (!board) {
      this.chooseUsbButton.disabled = true;
      this.refreshUsbButton.disabled = true;
      this.boardDetails.textContent = 'No supported board is available.';
      this.confirmationBoard.textContent = 'the selected board and revision';
      this.firmwareVersion.textContent = '—';
      this.recoveryList.replaceChildren();
      this.updateFlashButton();
      return;
    }

    this.chooseUsbButton.disabled = Boolean(this.operation);
    this.refreshUsbButton.disabled = Boolean(this.operation);
    this.boardDetails.textContent =
      `${board.vendor} · ${board.chip} · hardware Rev ` +
      `${board.hardwareRevision}`;
    this.confirmationBoard.textContent =
      `${board.name} Rev ${board.hardwareRevision}`;
    this.firmwareVersion.textContent = board.firmwareVersion;
    this.recoveryList.replaceChildren();

    for (const instruction of board.recoveryInstructions) {
      const item = this.document.createElement('li');
      item.textContent = instruction;
      this.recoveryList.append(item);
    }

    this.updateFlashButton();
  }

  updateFlashButton() {
    const board = this.selectedBoard();
    this.flashButton.disabled =
      this.busy ||
      this.operation ||
      !board ||
      !board.compatible ||
      !this.selectedPort ||
      this.selectedPortBoardId !== board.id ||
      !this.confirmRevision.checked ||
      !this.serial;
  }

  async flashSelectedBoard() {
    const board = this.selectedBoard();
    const port = this.selectedPort;

    if (
      !board ||
      !port ||
      this.selectedPortBoardId !== board.id ||
      !this.confirmRevision.checked ||
      !this.beginOperation('flash')
    ) {
      return;
    }

    this.clearLog();
    this.setProgress(0);
    this.flashStatus.textContent = 'Preparing verified firmware…';
    this.setDeviceStatus('Firmware flash in progress.', 'working');

    let transport = null;

    try {
      await this.closeSession();
      await sleep(500);
      const firmware = await this.api.getBoardFirmware(board.id);

      this.flashStatus.textContent = 'Connecting to the ESP32-S3 bootloader…';
      transport = new Transport(port, false);

      const loader = new ESPLoader({
        transport,
        baudrate: 460800,
        debugLogging: false,
        terminal: {
          clean: () => this.clearLog(),
          write: (message) => this.appendLog(message),
          writeLine: (message) => this.appendLog(message),
        },
      });
      const chipName = await loader.main();
      const detectedChipName = loader.chip?.CHIP_NAME || chipName;

      if (!isExpectedChip(detectedChipName, firmware.board.chip)) {
        throw new Error(
          `Wrong chip detected: expected ${firmware.board.chip}, ` +
            `found ${chipName}. Nothing was erased.`,
        );
      }

      this.flashStatus.textContent = 'Erasing and writing firmware…';
      await loader.writeFlash({
        fileArray: firmware.images.map((image) => ({
          address: image.address,
          data: new Uint8Array(image.data),
        })),
        flashMode: 'keep',
        flashFreq: 'keep',
        flashSize: 'keep',
        eraseAll: true,
        compress: true,
        calculateMD5Hash: calculateFirmwareMd5,
        reportProgress: (_fileIndex, written, total) => {
          const percent = Math.round((written / total) * 100);
          this.setProgress(percent);
          this.flashStatus.textContent = `Flashing firmware… ${percent}%`;
        },
      });

      this.flashStatus.textContent = 'Restarting the board…';
      await loader.after('hard_reset');
      await transport.disconnect();
      transport = null;

      this.setProgress(100);
      this.flashStatus.textContent =
        'Flash complete. Waiting for the Stream32 handshake…';
      await this.connectWithRetries(
        port,
        board.id,
        board.firmwareVersion,
      );
      this.flashStatus.textContent =
        'Firmware flashed and connected successfully.';
    } catch (error) {
      const message = errorMessage(error);
      this.appendLog(message);
      this.flashStatus.textContent = `Flash failed: ${message}`;
      this.setDeviceStatus('Flash failed. See recovery steps below.', 'error');
    } finally {
      if (transport) {
        try {
          await transport.disconnect();
        } catch {
          // The operating system may remove the bootloader port on reset.
        }
      }

      this.endOperation('flash');
    }
  }

  async connectWithRetries(
    port,
    expectedBoardId,
    expectedFirmwareVersion,
  ) {
    let lastError = null;

    for (let attempt = 0; attempt < RECONNECT_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleep(RECONNECT_DELAY_MS);
      }

      try {
        return await this.openSession(
          port,
          expectedBoardId,
          expectedFirmwareVersion,
        );
      } catch (error) {
        lastError = error;
        await this.closeSession();
      }
    }

    throw new Error(
      `Firmware was written, but the USB handshake failed: ` +
        errorMessage(lastError),
    );
  }

  async reconnectAuthorizedDevice() {
    if (
      this.busy ||
      this.session ||
      this.operation ||
      !this.serial ||
      this.boards.size === 0
    ) {
      return;
    }

    if (!this.beginOperation('reconnect')) {
      return;
    }

    this.setDeviceStatus('Looking for an authorized Stream32 device…', 'working');

    try {
      const ports = await this.serial.getPorts();

      for (const port of ports) {
        try {
          await this.openSession(port, null);
          return;
        } catch {
          await this.closeSession();
        }
      }

      this.setDeviceStatus('No Stream32 device is connected.', 'idle');
    } catch (error) {
      this.setDeviceStatus(
        `Could not reconnect: ${errorMessage(error)}`,
        'error',
      );
    } finally {
      this.endOperation('reconnect');
    }
  }

  async openSession(
    port,
    expectedBoardId,
    expectedFirmwareVersion = null,
  ) {
    await this.closeSession();
    await port.open({ baudRate: 115200, bufferSize: 4096 });

    let writer = null;

    try {
      writer = port.writable.getWriter();
      await writer.write(encodeHostHello());
    } catch (error) {
      try {
        await port.close();
      } catch {
        // Preserve the original setup error.
      }
      throw error;
    } finally {
      writer?.releaseLock();
    }

    let reader;

    try {
      reader = port.readable.getReader();
    } catch (error) {
      try {
        await port.close();
      } catch {
        // Preserve the original setup error.
      }
      throw error;
    }
    let resolveHandshake;
    let rejectHandshake;
    const handshake = new Promise((resolve, reject) => {
      resolveHandshake = resolve;
      rejectHandshake = reject;
    });
    const session = {
      boardId: null,
      handshakeComplete: false,
      port,
      readTask: null,
      reader,
    };
    this.session = session;

    const decoder = createLineDecoder({
      onError: (error) => {
        // Boot banners (e.g. "ESP-ROM:...") arrive before the firmware's
        // JSON protocol starts; only real post-handshake noise matters.
        if (session.handshakeComplete) {
          this.appendLog(`Protocol: ${errorMessage(error)}`);
        }
      },
      onMessage: (message) => {
        try {
          if (message.type === 'hello') {
            const hello = validateDeviceHello(
              message,
              expectedBoardId,
              1,
              expectedFirmwareVersion,
            );

            if (!this.boards.has(hello.boardId)) {
              throw new Error(
                `Device board is not in the current catalog: ${hello.boardId}`,
              );
            }

            session.boardId = hello.boardId;
            session.handshakeComplete = true;
            this.setDeviceStatus(
              `Connected · ${hello.boardId} · firmware ` +
                hello.firmwareVersion,
              'connected',
            );
            this.touchStatus.textContent = 'Touch the display to test input.';
            resolveHandshake(hello);
          } else if (message.type === 'touch' && session.handshakeComplete) {
            const touch = validateTouchMessage(message);
            this.touchStatus.textContent =
              `${touch.phase === 'down' ? 'Pressed' : 'Released'} at ` +
              `X ${touch.x}, Y ${touch.y}`;
          } else if (message.type === 'error') {
            this.appendLog(`Device error: ${message.code || 'unknown'}`);
          }
        } catch (error) {
          if (!session.handshakeComplete) {
            rejectHandshake(error);
          } else {
            this.appendLog(`Protocol: ${errorMessage(error)}`);
          }
        }
      },
    });

    session.readTask = (async () => {
      try {
        while (this.session === session) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          decoder.push(value);
        }
      } catch (error) {
        if (this.session === session) {
          rejectHandshake(error);
          this.setDeviceStatus(
            `Device connection lost: ${errorMessage(error)}`,
            'error',
          );
        }
      } finally {
        const ownsSession = this.session === session;
        reader.releaseLock();

        if (ownsSession) {
          this.session = null;

          try {
            await port.close();
          } catch {
            // The operating system may already have removed the port.
          }

          if (session.handshakeComplete) {
            this.setDeviceStatus('Stream32 device disconnected.', 'idle');
          }
        }
      }
    })();

    // Opening the USB Serial/JTAG port can reset the board, so a hello sent
    // while the firmware is still booting is lost. Repeat it until the
    // device answers or the handshake window closes.
    const helloTimer = setInterval(async () => {
      if (
        this.session !== session ||
        session.handshakeComplete ||
        !port.writable ||
        port.writable.locked
      ) {
        return;
      }

      const retryWriter = port.writable.getWriter();

      try {
        await retryWriter.write(encodeHostHello());
      } catch {
        // The timeout or read loop will report a failed connection.
      } finally {
        retryWriter.releaseLock();
      }
    }, HELLO_RETRY_MS);

    const timeout = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error('Timed out waiting for the device hello.')),
        HANDSHAKE_TIMEOUT_MS,
      );
    });

    try {
      return await Promise.race([handshake, timeout]);
    } catch (error) {
      await this.closeSession();
      throw error;
    } finally {
      clearInterval(helloTimer);
    }
  }

  async closeSession() {
    const session = this.session;

    if (!session) {
      return;
    }

    this.session = null;

    try {
      await session.reader.cancel();
    } catch {
      // A disconnected serial device can reject cancellation.
    }

    try {
      await session.readTask;
    } catch {
      // The read loop already reports connection errors to the UI.
    }

    try {
      await session.port.close();
    } catch {
      // The operating system may have already removed the port.
    }
  }
}

module.exports = {
  DeviceController,
  errorMessage,
};
