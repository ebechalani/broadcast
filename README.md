# WhatsApp Broadcast

Send a personalized WhatsApp message to everyone on a list, from **your own WhatsApp number**, one message at a time, at a human pace.

- Link your number by scanning a QR code (exactly like WhatsApp Web). The session is remembered.
- Import contacts from a **CSV or Excel** file, or paste rows straight from a spreadsheet. French and English column names (`Prénom / Nom / Téléphone`, `First name / Last name / Phone`) are detected automatically; any extra column becomes a placeholder.
- Write one message with placeholders such as `{{firstName}}`, `{{lastName}}` or `{{Classe}}`, preview it per contact, and send a test to yourself.
- Pacing built in: random delay between messages, pause after every batch, daily cap across all campaigns, optional quiet hours, "typing…" indicator, and a check that each number is actually on WhatsApp before sending.
- Pause, resume, stop, retry failures, export the results as CSV. An interrupted campaign (power cut, closed window) is offered for resume on the next start.

Everything runs locally on your computer. Nothing is sent to any server other than WhatsApp itself.

## Requirements

- Windows, macOS or Linux with [Node.js](https://nodejs.org) 18 or newer (tested with Node 24).
- A phone with WhatsApp (personal or WhatsApp Business app) that holds the number you want to send from. The phone must stay online while sending.
- About 500 MB of disk space the first time: the tool downloads its own copy of Chromium to drive WhatsApp Web.

## Quick start

On Windows, double-click **`start.cmd`**. It installs the dependencies the first time, starts the app and opens it in your browser.

From a terminal (any OS):

```bash
npm install
```

```bash
npm start
```

Then open <http://127.0.0.1:3210> if it does not open by itself.

### Step by step

1. **Link your WhatsApp number.** Click *Connect*. On your phone open WhatsApp → *Linked devices* → *Link a device* and scan the code. The badge turns green and shows your number. Next time the app starts it reconnects by itself.
2. **Contacts.** Drop a `.csv` or `.xlsx` file, or paste rows copied from Excel. Check the detected columns and fix them if needed. Invalid and duplicate numbers are flagged and skipped. Pick the default country used for numbers written without a country code (Lebanon by default).
3. **Message.** Type your text. Click a placeholder chip to insert it. The preview shows the message for a real contact. *Send a test to myself* delivers it to your own number so you can see it on your phone.
4. **Send.** Review the pacing settings, click *Start sending*, and keep the window open. You can pause or stop at any time; the progress table shows what happened to each contact.

A sample file is in `samples/contacts-sample.csv` (also downloadable from the app).

### Contact file format

Any of these work:

```csv
Prénom,Nom,Téléphone,Classe
Jean,Dupont,+961 70 123 456,6ème B
Marie,Curie,70 123 456,5ème A
```

```csv
First name;Last name;WhatsApp
Jean;Dupont;0096170123456
```

```text
Jean	Dupont	70 123 456        (pasted from Excel, no header row)
```

Numbers may be written with spaces, dashes, dots, parentheses, `+` or `00`. Numbers without a country code use the default country selected in the app. Numbers with a different country code (`+33 6…`) are kept as they are. A single "Nom" column containing `DUPONT Jean` is split into first and last name.

### Placeholders

| Placeholder | Value |
| --- | --- |
| `{{firstName}}` (also `{{prénom}}`, `{{first}}`) | First name |
| `{{lastName}}` (also `{{nom}}`, `{{surname}}`) | Last name |
| `{{fullName}}` | First and last name |
| `{{phone}}` | The number in international format |
| `{{Any column}}` | Any other column of your file, e.g. `{{Classe}}` |
| `{{firstName|there}}` | Fallback text when the value is empty |

Placeholder names are case- and accent-insensitive.

## Staying safe (please read)

WhatsApp does not allow bulk or automated messaging from the normal app and bans numbers that look like bots. The ban is usually permanent for that number. What gets numbers banned, in rough order of importance:

1. **Recipients reporting or blocking you.** This is the strongest signal. Only message people who expect to hear from you (parents, members, customers who gave you their number), say who you are in the first line, and make it easy to reply or opt out.
2. **Messaging people who do not have your number saved.** A few are fine; hundreds in a day are not. Ask people to save your number.
3. **Volume and speed.** Many messages in a short window, every day, with no replies coming back.
4. **Identical text.** Personalizing with the first name already helps; vary the wording between campaigns.
5. **Numbers that are not on WhatsApp.** Each failed delivery counts against you. Keep *Skip numbers that are not on WhatsApp* enabled.
6. **A brand-new number** that immediately starts broadcasting. Use a number that has been in normal use for weeks, with real conversations on it.

The defaults are deliberately conservative for a personal number:

| Setting | Default | Notes |
| --- | --- | --- |
| Delay between messages | 25–60 s, random | Below 15 s looks automated |
| Batch | 20 messages, then a 5-minute pause | Keeps the hourly rate low |
| Daily limit | 150, all campaigns together | Many users stay under 100; a new number should start at 20–30 a day and grow slowly |
| Quiet hours | off | Enable it to avoid sending at night |
| Number check | on | Skips numbers that are not on WhatsApp |
| Typing indicator | on | Shows "typing…" for a few seconds before each message |

With these defaults 100 messages take roughly 1 h 30. That is the point.

If a campaign starts failing repeatedly it pauses itself after 3 failures in a row. If WhatsApp disconnects, it pauses and resumes when the connection is back.

**The honest alternative:** for large or recurring volumes, use the official [WhatsApp Business Platform](https://business.whatsapp.com/products/business-platform) (Cloud API) with approved message templates. It costs money per conversation but it is the only method WhatsApp allows at scale.

## Where things are stored

Everything lives in the `data/` folder next to the app (ignored by git):

- `data/wa-session/` – the linked WhatsApp session. Delete it (or click *Unlink*) to start over with a new QR code.
- `data/campaigns/` – one JSON file per campaign with the status of every contact.
- `data/daily-counts.json` – messages sent per day, used for the daily limit.
- `data/settings.json` – your pacing settings.

## Configuration

Environment variables (all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3210` | Port of the local web interface (bound to 127.0.0.1 only) |
| `DATA_DIR` | `./data` | Where sessions, campaigns and settings are kept |
| `CHROME_PATH` | *(bundled Chromium)* | Use an installed browser instead, e.g. `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| `HEADLESS` | `false` | Set to `true` to hide the automated Chrome window |
| `OPEN_BROWSER` | `true` | Set to `false` to not open the interface on start |
| `DEFAULT_COUNTRY` | `LB` | Country for numbers without a country code |

## About the WhatsApp library version

`package.json` installs `whatsapp-web.js` from the library's **main branch on GitHub**, not from npm. As of October 2026 the npm release (1.34.7, April 2026) is broken against the current WhatsApp Web: a July 2026 change renamed an internal id field, so `getChatById` throws and `sendMessage` returns nothing even though messages are delivered. The fix was merged on 2026-09-26 but has not been released to npm. If a future `npm install` fails on the GitHub dependency, check <https://github.com/wwebjs/whatsapp-web.js/releases> for a release newer than 1.34.7 and pin that instead.

The automated Chrome window is **visible by default** (a separate window titled WhatsApp). Do not close it while sending. Several 2026 reports show headless logins stalling right after the QR scan; if you prefer it hidden, set `HEADLESS=true`.

## Troubleshooting

- **The QR code never appears / "Could not start"** – the bundled Chromium failed to launch. Install Google Chrome and set `CHROME_PATH`, or run `npx puppeteer browsers install chrome` in the project folder.
- **Stuck on "Loading WhatsApp…"** – wait a minute; big accounts take time to sync. If it stays stuck, click *Disconnect* then *Connect*.
- **"Authentication failed"** – the saved session is no longer valid (you unlinked the device from the phone). Click *Unlink*, then *Connect* and scan again.
- **Messages fail with "Evaluation failed" or similar** – WhatsApp Web changed and the `whatsapp-web.js` library needs an update: run `npm update whatsapp-web.js` and restart.
- **Numbers show as invalid** – check the default country, or write them with the country code (`+961 70 123 456`).

## Development

```bash
npm test
```

Runs the unit tests (phone normalization, file parsing, template rendering, campaign pacing and state machine). The WhatsApp layer is isolated in `src/whatsapp.js`; the campaign engine in `src/campaign.js` is tested against a fake client.

## Legal

This tool automates WhatsApp Web through an unofficial library ([whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js)). Using it is against WhatsApp's Terms of Service and can get the number banned. Use it only to message people who agreed to hear from you, respect your local data-protection and anti-spam laws, and use it at your own risk. It is not affiliated with WhatsApp or Meta.
