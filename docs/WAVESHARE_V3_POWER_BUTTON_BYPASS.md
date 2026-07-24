# Waveshare Rev 3 power-button bypass

The Waveshare `ESP32-S3-Touch-LCD-4` Rev 3.0 normally requires its power
button to be pressed after power is connected. For a permanently installed
Stream32 deck, two board-level bridges can make it start automatically.

> [!WARNING]
> This is a permanent hardware modification that may damage the board or void
> its warranty. It has only been verified on hardware marked **Rev 3.0**.
> Disconnect USB, external power, and any battery before soldering.

![Waveshare Rev 3 board showing the Q2 and Q5 bridges](../assets/Waveshare_v3_fix.JPG)

1. Confirm that the board silkscreen says **Rev 3.0**.
2. Electrically bridge **pin 1 to pin 3 on Q2**.
3. Electrically bridge **pin 1 to pin 3 on Q5**.
4. Inspect the work for unintended solder bridges before reconnecting power.

After both bridges are installed, the board starts when power is connected
without requiring the power button. The Stream32 firmware and flashing process
are otherwise unchanged.
