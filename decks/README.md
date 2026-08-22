# Share a deck

The **Community** tab in the Stream32 desktop app lists decks published by other
owners. Installing one adds it as a new named profile on the device you pick; it
never replaces a profile you already have.

This directory is where those decks come from. There is no account system and no
upload form: a shared deck is a pull request, so GitHub provides the identity and
review that a hosted gallery would otherwise need an account and a captcha to
approximate.

## Submit your deck

1. In Stream32, open the **Deck** view, select the profile you want to share,
   and choose **Export**. That writes a single-profile JSON file.
2. Fork this repository and copy the exported file to
   `decks/profiles/<your-id>.json`, where `<your-id>` is lowercase letters,
   digits, and dashes.
3. Add an entry to `decks/index.json`:

   ```json
   {
     "id": "obs-streaming",
     "source": "profiles/obs-streaming.json",
     "name": "OBS Streaming",
     "author": "your-github-handle",
     "summary": "Scene switching, mic mute, and a replay buffer key.",
     "board": "crowpanel-10",
     "tags": ["obs", "streaming"]
   }
   ```

   `id`, `source`, `name`, and `author` are required. `summary` (200
   characters), `board`, and up to eight lowercase `tags` are optional and only
   affect how the deck is described and searched.

4. Check it builds:

   ```sh
   node --test decks/tools/*.test.js
   node decks/tools/build-catalog.js --validate-only
   ```

5. Open a pull request.

`decks/dist/` is generated and must not be committed. Once the change reaches
`main`, the publish workflow rebuilds `catalog-v1.json` with each deck's byte
size and SHA-256 and updates the `decks-current` release. The desktop app
verifies both before it parses a download.

## What a shared deck may contain

A profile export is data, not code. Every key is validated by the same importer
the **Import** button uses, so a shared deck can only contain the action types
Stream32 already supports, and the build fails if a submitted file does not
import cleanly.

Two things to keep in mind when submitting or installing:

- A **Launch app / command** action carries a command line. It is visible in the
  key editor before you press anything, and it runs with your privileges when
  you do. Review those keys before installing a deck, exactly as you would a
  script from the internet. Submissions carrying one should say so in the pull
  request.
- Keys can carry embedded images. Keep the export small; the limit is 2 MiB.

Please only submit decks you made, and do not include personal paths,
credentials, tokens, or private URLs. Exports are plain JSON, so anything typed
into a **Type Text** key is readable by everyone who installs the deck.

## Removing a deck

Open a pull request deleting the entry from `decks/index.json` and the file
under `decks/profiles/`. The next publish drops it from the catalog. Clients
that already installed it keep their local copy, because installing creates an
ordinary profile that belongs to the owner from that point on.
