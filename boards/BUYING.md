# Buying a display

Stream32 runs on a handful of off-the-shelf ESP32 touch displays. This page
explains which one to buy and, just as importantly, what to avoid, since
several look-alike products share almost the same name but are not
compatible.

> [!NOTE]
> **Affiliate disclosure.** Some links on this page are Amazon affiliate links.
> If you buy through them, the project may earn a small commission at no extra
> cost to you. Using them is entirely optional; the same hardware works no
> matter where you buy it, and you are welcome to purchase directly from the
> vendor or any other retailer.

## At a glance

| Display | Size | Resolution | Deck size | Best for |
| --- | --- | --- | --- | --- |
| [Waveshare `ESP32-S3-Touch-LCD-4`](#waveshare-esp32-s3-touch-lcd-4) | 4" | 480x480 | up to 5x5, 8 pages | A compact, single-cable deck |
| [Elecrow `CrowPanel Advanced 10.1"`](#elecrow-crowpanel-advanced-101-esp32-p4) | 10.1" | 1024x600 | up to 40 keys/page, 8 pages | A large deck with many keys per page |
| [`ESP32-2432S028R`](#esp32-2432s028r-cheap-yellow-display) | 2.8" | 320x240 | up to 12 keys/page, 8 pages | The cheapest way to try Stream32 |

## Waveshare ESP32-S3-Touch-LCD-4

A compact 4-inch, 480x480 touch panel built on the ESP32-S3. It flashes and
communicates over a single native USB-C connection, so it is the simplest board
to get running.

- **Buy it:** [Waveshare ESP32-S3-Touch-LCD-4 on Amazon](https://amzn.to/3RxDX7I)
- **Confirm before ordering:**
  - The silkscreen hardware revision is **Rev 3.0**. Rev 4 uses different
    hardware and is not supported.
  - It is the **4-inch** `ESP32-S3-Touch-LCD-4`. The similarly named **4.3-inch**
    board is a different device and will not work.
- **Optional automatic power-on:** The
  [Rev 3 power-button bypass](../docs/WAVESHARE_V3_POWER_BUTTON_BYPASS.md)
  documents a board-level modification for installations that should start
  without pressing the power button.

## Elecrow CrowPanel Advanced 10.1" ESP32-P4

A large 10.1-inch, 1024x600 IPS panel built on the ESP32-P4, with up to 40 keys
per page and software-controlled brightness. Elecrow sells this line in several
sizes and chip variants, so choose carefully.

- **Buy it:** [Elecrow CrowPanel Advanced 10.1" ESP32-P4 on Amazon](https://amzn.to/4bEI74o)
- **Confirm before ordering:**
  - It is the **10.1-inch** panel and the **ESP32-P4** model (Amazon set name
    "10.1" ESP32-P4 Display"). The 5", 7", 9", and ESP32-S3 variants are
    different devices.
  - Hardware revisions **1.0 to 1.2** are supported.
- **Flash over the UART0 port.** One USB data cable connected to **UART0**
  normally provides both power and data, and it is the only port that can
  flash the board.
- **Two cables are better.** The separate **USB 2.0** port steadies a panel on
  a power-limited USB port, and Stream32 firmware also uses it as a native
  USB link that syncs artwork far faster than the UART0 bridge.

The on-board ESP32-C6 wireless module is not used by Stream32.

## ESP32-2432S028R (Cheap Yellow Display)

A 2.8-inch, 320x240 resistive touch panel on a classic ESP32, widely sold as
the "CYD". It is by far the cheapest supported board, and the compromise is
size: 12 keys per page instead of 25 or 40.

This model number is sold by many sellers and covers boards whose panels
differ. Listings routinely claim ILI9341 regardless of what ships, and the
community rule of thumb is that a single-connector board is ILI9341 while a
two-connector board is ST7789. Treat that as a hint, not a guarantee: a
dual-connector board has been confirmed working on the Stream32 profile.

- **Buy it:** [MELIFE ESP32-2432S028R 2-pack on Amazon](https://amzn.to/4wF7trj)
- **Confirm before ordering:**
  - That listing sells several sizes under one page. Choose the **2.8 inch**
    option; the 2.4", 3.5", and 4" variants are different devices.
  - The trailing **R** means resistive touch (XPT2046), which is what this
    profile expects. The **C** variants use capacitive GT911 touch and are
    different devices.
  - Either connector count is worth trying. If the screen lights up but the
    colours look wrong, that is adjustable from the Devices page. If it stays
    lit but blank, the panel controller really is a different one.
- **Expect to calibrate the touch panel once.** Resistive panels vary between
  units, and an uncalibrated one can leave part of the screen unreachable.
  **Calibrate touch** on the Devices page walks through four markers and
  stores the result on the board, where it survives both unplugging and
  firmware updates.
- Some USB-C revisions omit the CC resistors, so a USB-C-to-USB-C cable may
  not power the board. A USB-A-to-USB-C cable avoids the problem.

## What else you need

- A **USB data cable** (not a charge-only cable). The Waveshare uses its USB-C
  port; the CrowPanel uses the port labeled **UART0**. A second data cable for
  the CrowPanel's **USB 2.0** port is optional but recommended.
- Nothing else is required to get started. Enclosures and stands are optional and
  up to you. A printable stand for the CrowPanel 10.1" is in
  [`hardware/`](../hardware/Stream32-ElecrowPanel10_1.3mf).

Prices and availability change often and are intentionally not listed here.
Check the product page for current details.

Ready to set one up? Continue with the
[Getting started guide](../docs/GETTING_STARTED.md).
