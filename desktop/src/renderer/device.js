const { ESPLoader, Transport } = require('esptool-js');
const { calculateFirmwareMd5 } = require('./firmware-hash');
const {
  createLineDecoder,
  encodeDisplayMessage,
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
const FALLBACK_FLASH_BAUD = 460800;
const MANUAL_CONNECTION_HELP =
  'If auto-connect misses your deck, choose its USB / COM port.';

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error) {
  if (error?.name === 'NotFoundError') {
    return 'No serial port was selected.';
  }

  if (error?.name === 'NetworkError') {
    return (
      'The serial port is busy or the board was disconnected.' +
      (error.message ? ` (${error.message})` : '')
    );
  }

  return error instanceof Error ? error.message : String(error);
}

async function runFlashWithFallback({
  preferredBaud,
  runAttempt,
  onFallback = () => {},
}) {
  try {
    return await runAttempt(preferredBaud);
  } catch (error) {
    if (
      preferredBaud === FALLBACK_FLASH_BAUD ||
      error?.noBaudFallback === true
    ) {
      throw error;
    }

    await onFallback(error);
    return runAttempt(FALLBACK_FLASH_BAUD);
  }
}

class DeviceController {
  constructor({ api, deck = null, deckRuntime = null, document, serial }) {
    this.api = api;
    this.deck = deck;
    this.deckRuntime = deckRuntime;
    this.document = document;
    this.serial = serial;
    this.boards = new Map();
    this.busy = false;
    this.logLines = [];
    this.operation = null;
    this.selectedPort = null;
    this.selectedPortBoardId = null;
    this.serialPortRequestId = null;
    this.serialPortListEmpty = false;
    this.sessions = new Map();
    this.displayPolicy = {
      brightnessPercent: 100,
      idleTimeoutMinutes: 10,
      sleepWhenLocked: true,
    };
    this.machineLocked = false;

    this.boardSelect = document.querySelector('#board-select');
    this.boardDetails = document.querySelector('#board-details');
    this.catalogStatus = document.querySelector('#catalog-status');
    this.confirmRevision = document.querySelector('#confirm-revision');
    this.confirmationBoard = document.querySelector('#confirmation-board');
    this.deckConnectButton = document.querySelector('#deck-connect-device');
    this.deckPortSelect = document.querySelector('#deck-port-select');
    this.deckPortStatus = document.querySelector('#deck-port-status');
    this.deviceStatus = document.querySelector('#device-status');
    this.firmwareVersion = document.querySelector('#firmware-version');
    this.flashButton = document.querySelector('#flash-device');
    this.fullErase = document.querySelector('#full-erase');
    this.flashLog = document.querySelector('#flash-log');
    this.flashProgress = document.querySelector('#flash-progress');
    this.flashStep = document.querySelector('#flash-step');
    this.flashStatus = document.querySelector('#flash-status');
    this.reconnectButton = document.querySelector('#reconnect-device');
    this.recoveryList = document.querySelector('#recovery-steps');
    this.refreshButton = document.querySelector('#refresh-boards');
    this.refreshUsbButton = document.querySelector('#refresh-usb');
    this.testStep = document.querySelector('#test-step');
    this.touchStatus = document.querySelector('#touch-status');
    this.usbPortSelect = document.querySelector('#usb-port-select');
    this.usbPortStatus = document.querySelector('#usb-port-status');
  }

  async initialize() {
    this.deckConnectButton.addEventListener('click', () => {
      if (this.operation === 'deck-select') {
        this.cancelSerialPortSelection();
      } else {
        this.connectSelectedDevice();
      }
    });
    this.deckPortSelect.addEventListener('change', () =>
      this.confirmSerialPortSelection(),
    );
    this.deck?.deviceSelect.addEventListener('change', () =>
      this.resetDeckPortStatus(),
    );
    this.boardSelect.addEventListener('change', () => {
      this.confirmRevision.checked = false;
      this.fullErase.checked = false;
      this.clearUsbSelection();
      this.updateSelectedBoard();
    });
    this.refreshUsbButton.addEventListener('click', () => {
      if (this.operation === 'usb-select') {
        this.cancelSerialPortSelection();
      } else {
        this.selectUsbPort();
      }
    });
    this.usbPortSelect.addEventListener('change', () =>
      this.confirmSerialPortSelection(),
    );
    this.confirmRevision.addEventListener('change', () =>
      this.updateFlashButton(),
    );
    this.flashButton.addEventListener('click', () => {
      this.flashSelectedBoard();
    });
    this.refreshButton.addEventListener('click', () => {
      this.loadBoards(true);
    });
    this.reconnectButton.addEventListener('click', async () => {
      await this.reconnectAuthorizedDevice(true);

      if (this.sessions.size > 0) {
        this.showTouchTest();
      }
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
    this.api.onSerialPortList((request) => {
      this.showSerialPorts(request);
    });

    if (!this.serial) {
      this.setDeviceStatus(
        'Web Serial is unavailable in this Electron build.',
        'error',
      );
      this.flashButton.disabled = true;
      this.deckConnectButton.disabled = true;
      this.deckPortSelect.disabled = true;
      this.refreshUsbButton.disabled = true;
      this.usbPortSelect.disabled = true;
      this.reconnectButton.disabled = true;
      this.fullErase.disabled = true;
      return;
    }

    this.serial.addEventListener('connect', () => {
      if (!this.operation) {
        this.reconnectAuthorizedDevice();
      }
    });
    this.serial.addEventListener('disconnect', (event) => {
      if (this.selectedPort === event.target && !this.busy) {
        this.clearUsbSelection('The selected USB/COM port was disconnected.');
      }

      if (this.sessions.has(event.target)) {
        this.closeSessionForPort(event.target);
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
        this.setUsbPortDisplay('Previously authorized USB port');
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
    this.deckConnectButton.disabled = true;
    this.deckPortSelect.disabled = true;
    this.refreshUsbButton.disabled = true;
    this.usbPortSelect.disabled = true;
    this.refreshButton.disabled = true;
    this.reconnectButton.disabled = true;
    this.confirmRevision.disabled = true;
    this.fullErase.disabled = true;
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
    this.deckConnectButton.disabled = !this.serial;
    this.deckConnectButton.textContent = 'Connect COM port';
    this.deckPortSelect.disabled = true;
    this.deckPortSelect.hidden = true;
    this.refreshUsbButton.disabled =
      !this.serial || !this.selectedBoard();
    this.refreshUsbButton.textContent = 'Refresh ports';
    this.usbPortSelect.disabled = true;
    this.refreshButton.disabled = false;
    this.reconnectButton.disabled = !this.serial;
    this.confirmRevision.disabled = false;
    this.fullErase.disabled = false;
    this.updateFlashButton();
  }

  setProgress(value) {
    this.flashProgress.value = Math.max(0, Math.min(100, value));
  }

  setUsbPortDisplay(message) {
    this.setPortDisplay(this.usbPortSelect, message);
  }

  setPortDisplay(select, message) {
    const option = this.document.createElement('option');
    option.value = '';
    option.textContent = message;
    select.replaceChildren(option);
    select.disabled = true;
  }

  resetDeckPortStatus() {
    this.deckPortStatus.textContent = MANUAL_CONNECTION_HELP;
    this.deckPortStatus.dataset.state = 'idle';
  }

  clearUsbSelection(message = 'No USB or COM port selected.') {
    this.selectedPort = null;
    this.selectedPortBoardId = null;
    this.setUsbPortDisplay(message);
    this.usbPortStatus.textContent = message;
    this.usbPortStatus.dataset.state = 'idle';
    this.updateFlashButton();
  }

  serialPortControls() {
    if (this.operation === 'deck-select') {
      return {
        button: this.deckConnectButton,
        select: this.deckPortSelect,
        status: this.deckPortStatus,
      };
    }

    if (this.operation === 'usb-select') {
      return {
        button: this.refreshUsbButton,
        select: this.usbPortSelect,
        status: this.usbPortStatus,
      };
    }

    return null;
  }

  showSerialPorts(request) {
    if (
      !Number.isSafeInteger(request?.requestId) ||
      !Array.isArray(request.ports)
    ) {
      return;
    }

    const controls = this.serialPortControls();

    if (!controls) {
      this.api.selectSerialPort(request.requestId, '').catch(console.error);
      return;
    }

    const { button, select, status } = controls;
    this.serialPortRequestId = request.requestId;
    this.serialPortListEmpty = request.ports.length === 0;
    status.dataset.state = 'idle';
    select.replaceChildren();
    select.hidden = false;

    const placeholder = this.document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = this.serialPortListEmpty
      ? 'No USB / COM ports found'
      : 'Select a USB / COM port';
    placeholder.disabled = !this.serialPortListEmpty;
    placeholder.selected = true;
    select.append(placeholder);

    if (this.serialPortListEmpty) {
      status.textContent = 'No USB / COM ports found.';
      this.api.selectSerialPort(request.requestId, '').catch(console.error);
      return;
    }

    for (const port of request.ports) {
      const option = this.document.createElement('option');
      option.value = port.id;
      option.textContent = port.label;
      select.append(option);
    }

    select.disabled = false;
    status.textContent =
      `${request.ports.length} USB / COM ` +
      `${request.ports.length === 1 ? 'port' : 'ports'} found.`;
    button.textContent = 'Cancel';
    button.disabled = false;
    select.focus();
  }

  async confirmSerialPortSelection() {
    const operation = this.operation;
    const controls = this.serialPortControls();
    const portId = controls?.select.value;

    if (!controls || !this.serialPortRequestId || !portId) {
      return;
    }

    controls.select.disabled = true;
    controls.button.disabled = true;
    controls.status.textContent =
      `Selecting ${controls.select.selectedOptions[0].textContent}…`;

    try {
      const accepted = await this.api.selectSerialPort(
        this.serialPortRequestId,
        portId,
      );

      if (!accepted) {
        throw new Error('The serial port list expired. Refresh and try again.');
      }
    } catch (error) {
      controls.status.textContent =
        `Could not select USB/COM: ${errorMessage(error)}`;
      controls.status.dataset.state = 'error';
      this.endOperation(operation);
    }
  }

  async cancelSerialPortSelection() {
    const operation = this.operation;
    const controls = this.serialPortControls();

    if (!controls || !this.serialPortRequestId) {
      return;
    }

    controls.select.disabled = true;
    controls.button.disabled = true;

    try {
      await this.api.selectSerialPort(this.serialPortRequestId, '');
    } catch (error) {
      controls.status.textContent =
        `Could not cancel USB/COM: ${errorMessage(error)}`;
      controls.status.dataset.state = 'error';
      this.endOperation(operation);
    }
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

    this.serialPortRequestId = null;
    this.serialPortListEmpty = false;
    this.setUsbPortDisplay('Scanning for USB / COM ports…');
    this.usbPortStatus.textContent = 'Scanning for USB / COM ports…';
    this.refreshUsbButton.textContent = 'Scanning…';

    try {
      // requestPort must run directly from this click before user activation
      // expires. Electron sends its port list back to this screen.
      const port = await this.serial.requestPort({
        filters: board.usbFilters,
      });
      const selectedLabel =
        this.usbPortSelect.selectedOptions[0]?.textContent || 'Serial port';
      await this.closeSessionForPort(port);
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
      this.usbPortStatus.textContent = `${selectedLabel}${usbId}`;
      this.usbPortStatus.dataset.state = 'ready';
    } catch (error) {
      this.clearUsbSelection(
        error?.name === 'NotFoundError'
          ? this.serialPortListEmpty
            ? 'No USB / COM ports found.'
            : 'USB/COM selection cancelled.'
          : `Could not select USB/COM: ${errorMessage(error)}`,
      );
    } finally {
      this.serialPortRequestId = null;
      this.endOperation('usb-select');
    }
  }

  async connectSelectedDevice() {
    if (!this.serial || !this.beginOperation('deck-select')) {
      return;
    }

    this.serialPortRequestId = null;
    this.serialPortListEmpty = false;
    this.setPortDisplay(
      this.deckPortSelect,
      'Scanning for USB / COM ports…',
    );
    this.deckPortSelect.hidden = false;
    this.deckPortStatus.textContent = 'Scanning for USB / COM ports…';
    this.deckPortStatus.dataset.state = 'idle';
    this.deckConnectButton.textContent = 'Scanning…';

    try {
      // requestPort must stay in this click handler's call chain so Chromium
      // preserves user activation while Electron renders the inline list.
      const port = await this.serial.requestPort();
      const selectedLabel =
        this.deckPortSelect.selectedOptions[0]?.textContent || 'Serial port';
      this.deckPortSelect.disabled = true;
      this.deckConnectButton.disabled = true;
      this.deckPortStatus.textContent = `Connecting to ${selectedLabel}…`;
      await this.openSession(port, null);
      this.resetDeckPortStatus();
    } catch (error) {
      const cancelled = error?.name === 'NotFoundError';
      this.deckPortStatus.textContent = cancelled
        ? this.serialPortListEmpty
          ? 'No USB / COM ports found.'
          : 'USB/COM selection cancelled.'
        : `Could not connect: ${errorMessage(error)}`;
      this.deckPortStatus.dataset.state = cancelled ? 'idle' : 'error';
    } finally {
      this.serialPortRequestId = null;
      this.endOperation('deck-select');
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

    for (const line of lines) {
      const kind = /^(?:Device error|Display control|Protocol):/.test(line)
        ? 'protocol'
        : 'flash';
      this.api.logDiagnosticLine?.(kind, line.slice(0, 2048));
    }

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
      this.deck?.setBoards(result.boards);
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
      this.refreshUsbButton.disabled = true;
      this.boardDetails.textContent = 'No supported board is available.';
      this.confirmationBoard.textContent = 'the selected board and revision';
      this.firmwareVersion.textContent = '—';
      this.recoveryList.replaceChildren();
      this.updateFlashButton();
      return;
    }

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

  showTouchTest() {
    this.flashStep.open = false;
    this.testStep.open = true;
    this.testStep.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async flashFirmwareAttempt(port, firmware, baudrate, fullErase) {
    const transport = new Transport(port, false);

    try {
      this.flashStatus.textContent =
        `Connecting to the ${firmware.board.chip} bootloader at ` +
        `${baudrate} baud…`;
      const loader = new ESPLoader({
        transport,
        baudrate,
        debugLogging: false,
        terminal: {
          clean: () => {},
          write: (message) => this.appendLog(message),
          writeLine: (message) => this.appendLog(message),
        },
      });
      const chipName = await loader.main();
      const detectedChipName = loader.chip?.CHIP_NAME || chipName;

      if (!isExpectedChip(detectedChipName, firmware.board.chip)) {
        const error = new Error(
          `Wrong chip detected: expected ${firmware.board.chip}, ` +
            `found ${chipName}. Nothing was erased.`,
        );
        error.noBaudFallback = true;
        throw error;
      }

      this.flashStatus.textContent = fullErase
        ? 'Fully erasing the chip and writing firmware…'
        : 'Writing verified firmware sectors…';
      await loader.writeFlash({
        fileArray: firmware.images.map((image) => ({
          address: image.address,
          data: new Uint8Array(image.data),
        })),
        flashMode: 'keep',
        flashFreq: 'keep',
        flashSize: 'keep',
        eraseAll: fullErase,
        compress: true,
        calculateMD5Hash: calculateFirmwareMd5,
        reportProgress: (_fileIndex, written, total) => {
          const percent = Math.round((written / total) * 100);
          this.setProgress(percent);
          this.flashStatus.textContent = `Flashing firmware… ${percent}%`;
        },
      });

      return { loader, transport };
    } catch (error) {
      try {
        await transport.disconnect();
      } catch {
        // A failed attempt may already have closed or reset the port.
      }
      throw error;
    }
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
      await this.closeSessionForPort(port);
      await sleep(500);
      const firmware = await this.api.getBoardFirmware(board.id);
      const fullErase = this.fullErase.checked;
      const result = await runFlashWithFallback({
        preferredBaud: firmware.board.preferredFlashBaud,
        runAttempt: (baudrate) =>
          this.flashFirmwareAttempt(port, firmware, baudrate, fullErase),
        onFallback: async (error) => {
          this.appendLog(
            `High-speed flash failed: ${errorMessage(error)}. ` +
              `Restarting the complete write at ${FALLBACK_FLASH_BAUD} baud.`,
          );
          this.setProgress(0);
          this.flashStatus.textContent =
            `Retrying the complete write at ${FALLBACK_FLASH_BAUD} baud…`;
          await sleep(500);
        },
      });
      const { loader } = result;
      transport = result.transport;

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
      this.showTouchTest();
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
        await this.closeSessionForPort(port);
      }
    }

    throw new Error(
      `Firmware was written, but the USB handshake failed: ` +
        errorMessage(lastError),
    );
  }

  connectedSessions() {
    return [...this.sessions.values()].filter(
      (session) => session.handshakeComplete,
    );
  }

  updateDeviceStatusSummary() {
    const connected = this.connectedSessions();

    if (connected.length === 0) {
      this.setDeviceStatus('No Stream32 device is connected.', 'idle');
    } else if (connected.length === 1) {
      const { hello } = connected[0];
      this.setDeviceStatus(
        `Connected · ${hello.boardId} · firmware ${hello.firmwareVersion}`,
        'connected',
      );
    } else {
      this.setDeviceStatus(
        `${connected.length} Stream32 devices connected.`,
        'connected',
      );
    }
  }

  displayControlSupported(session) {
    return session.hello?.features?.includes('display-control') === true;
  }

  displayBrightnessSupported(session) {
    return session.hello?.features?.includes('display-brightness') === true;
  }

  async applyDisplayPolicyToSession(session) {
    if (!session.handshakeComplete || !this.displayControlSupported(session)) {
      return;
    }

    await session.send(
      encodeDisplayMessage({
        awake: !(this.displayPolicy.sleepWhenLocked && this.machineLocked),
        idleTimeoutSeconds: this.displayPolicy.idleTimeoutMinutes * 60,
        ...(this.displayBrightnessSupported(session)
          ? { brightness: this.displayPolicy.brightnessPercent }
          : {}),
      }),
    );
  }

  async broadcastDisplayPolicy() {
    const tasks = this.connectedSessions()
      .filter((session) => this.displayControlSupported(session))
      .map((session) => this.applyDisplayPolicyToSession(session));
    const results = await Promise.allSettled(tasks);

    for (const result of results) {
      if (result.status === 'rejected') {
        this.appendLog(`Display control: ${errorMessage(result.reason)}`);
      }
    }
  }

  setDisplayPolicy(policy) {
    this.displayPolicy = {
      brightnessPercent: policy.brightnessPercent,
      idleTimeoutMinutes: policy.idleTimeoutMinutes,
      sleepWhenLocked: policy.sleepWhenLocked,
    };
    return this.broadcastDisplayPolicy();
  }

  setMachineLocked(locked) {
    if (this.machineLocked === locked) {
      return Promise.resolve();
    }

    this.machineLocked = locked;
    return this.broadcastDisplayPolicy();
  }

  async reconnectAuthorizedDevice(force = false) {
    if (
      this.busy ||
      this.operation ||
      !this.serial ||
      this.boards.size === 0
    ) {
      return;
    }

    if (!this.beginOperation('reconnect')) {
      return;
    }

    this.setDeviceStatus('Looking for authorized Stream32 devices…', 'working');

    try {
      if (force) {
        await this.closeAllSessions();
      }

      const ports = await this.serial.getPorts();

      for (const port of ports) {
        if (this.sessions.has(port)) {
          continue;
        }

        try {
          await this.openSession(port, null);
        } catch {
          await this.closeSessionForPort(port);
        }
      }

      this.updateDeviceStatusSummary();
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
    await this.closeSessionForPort(port);
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
      hello: null,
      handshakeComplete: false,
      port,
      readTask: null,
      reader,
      send: null,
      sendChain: Promise.resolve(),
    };
    // Deck pushes serialize their writes so image chunks never interleave
    // with layout or page messages on the same port.
    session.send = (bytes) => {
      const task = session.sendChain.then(async () => {
        if (this.sessions.get(port) !== session) {
          throw new Error('The device session is closed.');
        }

        const sendWriter = port.writable.getWriter();

        try {
          await sendWriter.write(bytes);
        } finally {
          sendWriter.releaseLock();
        }
      });
      session.sendChain = task.catch(() => {});
      return task;
    };
    this.sessions.set(port, session);

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

            session.hello = hello;
            session.handshakeComplete = true;
            this.updateDeviceStatusSummary();
            this.touchStatus.textContent = 'Touch the display to test input.';
            this.applyDisplayPolicyToSession(session).catch((error) => {
              this.appendLog(`Display control: ${errorMessage(error)}`);
            });
            this.deckRuntime?.attachSession(
              session,
              this.boards.get(hello.boardId),
            );
            resolveHandshake(hello);
          } else if (message.type === 'touch' && session.handshakeComplete) {
            const touch = validateTouchMessage(message);
            this.touchStatus.textContent =
              `${touch.phase === 'down' ? 'Pressed' : 'Released'} at ` +
              `X ${touch.x}, Y ${touch.y}`;
          } else if (session.handshakeComplete && this.deckRuntime) {
            // layout-ack, image-ack, page, press, and error replies belong
            // to the deck sync engine after the handshake.
            this.deckRuntime.handleDeviceMessage(session, message);
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
        while (this.sessions.get(port) === session) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          decoder.push(value);
        }
      } catch (error) {
        if (this.sessions.get(port) === session) {
          rejectHandshake(error);
          this.setDeviceStatus(
            `Device connection lost: ${errorMessage(error)}`,
            'error',
          );
        }
      } finally {
        const ownsSession = this.sessions.get(port) === session;
        reader.releaseLock();

        if (ownsSession) {
          this.sessions.delete(port);

          try {
            await port.close();
          } catch {
            // The operating system may already have removed the port.
          }

          if (session.handshakeComplete) {
            this.deckRuntime?.detachSession(session);
            this.updateDeviceStatusSummary();
          }
        }
      }
    })();

    // Opening the USB Serial/JTAG port can reset the board, so a hello sent
    // while the firmware is still booting is lost. Repeat it until the
    // device answers or the handshake window closes.
    const helloTimer = setInterval(async () => {
      if (
        this.sessions.get(port) !== session ||
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
      await this.closeSessionForPort(port);
      throw error;
    } finally {
      clearInterval(helloTimer);
    }
  }

  async closeSessionForPort(port) {
    const session = this.sessions.get(port);

    if (!session) {
      return;
    }

    this.sessions.delete(port);

    if (session.handshakeComplete) {
      this.deckRuntime?.detachSession(session);
    }

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

  async closeAllSessions() {
    for (const port of [...this.sessions.keys()]) {
      await this.closeSessionForPort(port);
    }
  }
}

module.exports = {
  DeviceController,
  errorMessage,
  runFlashWithFallback,
};
