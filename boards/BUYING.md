# Buying a display

Stream32 runs on two off-the-shelf ESP32 touch displays. This page explains
which one to buy and, just as importantly, what to avoid, since several
look-alike products share almost the same name but are not compatible.

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
- **Plan for two USB connections.** The board flashes and talks over the **UART0**
  port, but the 10.1" panel draws more power than UART0 alone can supply, so the
  separate **USB 2.0** port must also be connected. The box includes one
  USB-A-to-Type-C cable, so have a **second USB cable** ready to power the board
  while UART0 carries data.

The on-board ESP32-C6 wireless module is not used by Stream32.

## What else you need

- A **USB data cable** (not a charge-only cable). The Waveshare uses one USB-C
  connection; the CrowPanel needs two connections at once (data plus power).
- Nothing else is required to get started. Enclosures and stands are optional and
  up to you.

Prices and availability change often and are intentionally not listed here.
Check the product page for current details.

Ready to set one up? Continue with the
[Getting started guide](../docs/GETTING_STARTED.md).
