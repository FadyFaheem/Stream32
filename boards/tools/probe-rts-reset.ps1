<#
.SYNOPSIS
Checks whether pulsing RTS restarts a Stream32 board over its USB-serial bridge.

.DESCRIPTION
The desktop app restarts a freshly flashed board by driving esptool.py's reset
sequence over the serial control lines: release DTR (IO0), assert RTS to pull EN
low, hold, then release. Boards whose bridge does not carry RTS through to EN
cannot be restarted that way and are marked "postFlashReset": "manual" in their
board.json, which makes the app ask for a physical RST press instead.

This script answers, for one board, whether that pulse actually works. It runs
three windows and reports what arrived on each:

  1. Baseline  - no signal change. Establishes the idle noise floor.
  2. Control   - RTS released only. Should produce nothing on its own.
  3. Pulse     - the real sequence. A board that resets prints its ROM banner.

Any bytes in the pulse window mean the chip restarted, even if they are garbled:
the ROM banner's baud rate does not always match the protocol baud, so unreadable
output still counts as evidence of a reset.

Close Stream32 before running this. The serial port is exclusive.

.PARAMETER PortName
Serial port to probe, for example COM6. Autodetects a CH340/CH910x bridge when
omitted. For the CrowPanel this must be the UART0 port, not the USB 2.0 port.

.PARAMETER BaudRate
Read baud. Defaults to 115200, the Stream32 protocol baud.

.EXAMPLE
.\probe-rts-reset.ps1
.EXAMPLE
.\probe-rts-reset.ps1 -PortName COM6
#>

[CmdletBinding()]
param(
    [string]$PortName,
    [int]$BaudRate = 115200
)

$ErrorActionPreference = 'Stop'

function Find-BridgePort {
    $serialPorts = @(
        Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '\(COM\d+\)' }
    )

    # Named bridge chips only. A generic "USB Serial Device" is the CDC class
    # driver, which on the CrowPanel is its USB 2.0 port: that port cannot flash
    # the board and has no RTS path to EN, so picking it would fail misleadingly.
    # Not named $matches: that collides with the automatic variable -match fills.
    $candidates = @(
        $serialPorts | Where-Object { $_.Name -match 'CH340|CH910|CP210|FT232' }
    )

    if ($candidates.Count -eq 0) {
        $generic = @($serialPorts | Where-Object { $_.Name -match 'USB.?SERIAL' })

        if ($generic.Count -gt 0) {
            Write-Host '  only a generic USB serial device found, not a known bridge' -ForegroundColor Yellow
            Write-Host '  pass -PortName explicitly if that really is the flashing port' -ForegroundColor Yellow
        }

        return $null
    }

    foreach ($device in $candidates) {
        Write-Host ("  found {0}" -f $device.Name) -ForegroundColor DarkGray
    }

    if ($candidates.Count -gt 1) {
        Write-Host '  more than one bridge present; pass -PortName to pick' -ForegroundColor Yellow
    }

    if ($candidates[0].Name -match '\((COM\d+)\)') {
        return $Matches[1]
    }

    return $null
}

# Drains whatever arrives over a fixed window rather than stopping at the first
# byte, so a multi-line ROM banner is captured whole.
function Read-Window {
    param(
        [System.IO.Ports.SerialPort]$Port,
        [int]$Milliseconds
    )

    $deadline = [Diagnostics.Stopwatch]::StartNew()
    $collected = New-Object System.Collections.Generic.List[byte]

    while ($deadline.ElapsedMilliseconds -lt $Milliseconds) {
        $waiting = 0

        try {
            $waiting = $Port.BytesToRead
        } catch {
            $waiting = 0
        }

        if ($waiting -gt 0) {
            $buffer = New-Object byte[] $waiting
            $read = $Port.Read($buffer, 0, $waiting)

            for ($i = 0; $i -lt $read; $i++) {
                $collected.Add($buffer[$i])
            }
        } else {
            Start-Sleep -Milliseconds 20
        }
    }

    return , $collected.ToArray()
}

function Show-Bytes {
    param([byte[]]$Bytes)

    if ($Bytes.Length -eq 0) {
        Write-Host '    (nothing)' -ForegroundColor DarkGray
        return
    }

    $text = [Text.Encoding]::ASCII.GetString($Bytes)
    $printable = ($text -replace '[^\x20-\x7E\r\n]', '.')

    foreach ($line in ($printable -split "`r?`n")) {
        if ($line.Trim()) {
            Write-Host "    | $line" -ForegroundColor Gray
        }
    }
}

if (-not $PortName) {
    Write-Host 'Looking for a USB-serial bridge...' -ForegroundColor Cyan
    $PortName = Find-BridgePort

    if (-not $PortName) {
        throw 'No CH340/CP210x/FTDI bridge found. Pass -PortName, for example -PortName COM6.'
    }
}

Write-Host ''
Write-Host ("Probing {0} at {1} baud" -f $PortName, $BaudRate) -ForegroundColor Cyan
Write-Host ''

$port = New-Object System.IO.Ports.SerialPort $PortName, $BaudRate, 'None', 8, 'One'
$port.ReadTimeout = 200
$port.WriteTimeout = 200

try {
    $port.Open()
} catch {
    throw ("Could not open {0}: {1} (is Stream32 still running?)" -f $PortName, $_.Exception.Message)
}

try {
    # Opening the port can itself jog the control lines, so settle and discard
    # anything that produced before measuring the real windows.
    $port.DtrEnable = $false
    $port.RtsEnable = $false
    Start-Sleep -Milliseconds 600
    $port.DiscardInBuffer()

    Write-Host '1. Baseline, no signal change (1.5s)' -ForegroundColor White
    $baseline = Read-Window -Port $port -Milliseconds 1500
    Write-Host ("   {0} byte(s)" -f $baseline.Length)
    Show-Bytes -Bytes $baseline

    Write-Host ''
    Write-Host '2. Control, release RTS only (1.5s)' -ForegroundColor White
    $port.RtsEnable = $false
    $control = Read-Window -Port $port -Milliseconds 1500
    Write-Host ("   {0} byte(s)" -f $control.Length)
    Show-Bytes -Bytes $control

    Write-Host ''
    Write-Host '3. Pulse: DTR low, RTS high 100ms, RTS low (3s)' -ForegroundColor White
    $port.DiscardInBuffer()
    $port.DtrEnable = $false
    $port.RtsEnable = $true
    Start-Sleep -Milliseconds 100
    $port.RtsEnable = $false
    $pulse = Read-Window -Port $port -Milliseconds 3000
    Write-Host ("   {0} byte(s)" -f $pulse.Length)
    Show-Bytes -Bytes $pulse
} finally {
    if ($port.IsOpen) {
        $port.Close()
    }

    $port.Dispose()
}

Write-Host ''
Write-Host ('-' * 58) -ForegroundColor DarkGray

$quiet = $baseline.Length + $control.Length

if ($pulse.Length -gt 0 -and $quiet -eq 0) {
    Write-Host 'RESULT: the RTS pulse restarts this board.' -ForegroundColor Green
    Write-Host 'The board stayed silent until the pulse, then booted. This board'
    Write-Host 'can use "postFlashReset": "automatic" and drop the RST prompt.'
} elseif ($pulse.Length -gt 0) {
    Write-Host 'RESULT: inconclusive, the line was already noisy.' -ForegroundColor Yellow
    Write-Host 'Output arrived before the pulse, so the pulse cannot be credited'
    Write-Host 'with it. Power-cycle the board, let it settle, and run again.'
} else {
    Write-Host 'RESULT: the RTS pulse does not restart this board.' -ForegroundColor Red
    Write-Host 'Nothing arrived after the pulse, so RTS most likely does not reach'
    Write-Host 'EN on this bridge. Keep "postFlashReset": "manual".'
    Write-Host ''
    Write-Host 'Worth ruling out first: confirm this is the UART0 port and not the'
    Write-Host 'USB 2.0 port, and try -BaudRate 74880 in case the ROM banner is'
    Write-Host 'landing at a baud this run could not read.'
}

Write-Host ('-' * 58) -ForegroundColor DarkGray
