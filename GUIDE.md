# WhatsApp Broadcast – Step-by-step guide

This guide takes you from an empty PC to a sent campaign. Follow it in order the first time; afterwards you only need Part 4 onwards.

---

## Part 1 – What you need (5 minutes)

- A Windows PC that stays on while messages are sent (laptop plugged in is fine).
- The phone that holds the WhatsApp number you will send from. It must stay switched on and connected to the internet during sending.
- An internet connection on the PC.
- Your contact list in Excel, or as a CSV file, with at least a name and a phone number per line.

---

## Part 2 – Install (once per PC, about 10 minutes)

### Step 1 – Install Node.js

1. Open <https://nodejs.org> in your browser.
2. Click the big green **LTS** download button.
3. Run the downloaded installer. Click **Next** on every screen, keep all defaults, click **Install**, then **Finish**.

### Step 2 – Download the app

1. Open <https://github.com/ebechalani/broadcast>.
2. Click the green **Code** button, then **Download ZIP**.
3. Open the downloaded `broadcast-main.zip` and drag the folder inside it to your **Documents** folder.
4. Rename the folder to `broadcast` (optional, just shorter).

### Step 3 – First start

1. Open the `broadcast` folder.
2. Double-click **`start.cmd`**.
3. A black window opens and installs the app. The first time this takes **3 to 10 minutes** and downloads about 500 MB (it includes its own copy of the Chrome browser). Do not close the black window.
4. When it is done, your browser opens the page **http://127.0.0.1:3210** by itself, and a second Chrome window titled *WhatsApp* appears. **Keep both open.** If the page did not open, type `127.0.0.1:3210` in your browser's address bar.

If Windows shows a blue "Windows protected your PC" box when you double-click `start.cmd`, click **More info**, then **Run anyway**. The file only runs the app; you can open it in Notepad to see what it does.

Every later start is the same: double-click `start.cmd`, wait a few seconds, the page opens.

To stop the app: close the black window (or press Ctrl+C in it). Any campaign in progress pauses and is offered again at the next start.

---

## Part 3 – Link your WhatsApp number (once)

1. On the page, in box **1 – Link your WhatsApp number**, click **Connect**.
2. A QR code appears after a few seconds.
3. On your phone, open **WhatsApp**:
   - Android: tap the **⋮** menu (top right) → **Linked devices** → **Link a device**.
   - iPhone: tap **Settings** (bottom right) → **Linked devices** → **Link a device**.
4. Point the phone's camera at the QR code on the screen.
5. Wait. The badge at the top of the page turns green and shows **Connected: +961…** with your number. Big accounts can take a minute to load.

The link is remembered. The next time you start the app it reconnects by itself, without a QR code. You only scan again if you click **Unlink**, or if you remove the device from your phone (WhatsApp → Linked devices → tap the device → Log out).

---

## Part 4 – Prepare the contact list

The app reads an Excel file (`.xlsx`) or a CSV file, or rows pasted straight from Excel.

### Easiest: download a ready-made Excel template

1. In box 2 **Contacts**, click **Excel template…**
2. In **How many variables to add**, type how many extra pieces of information you want per person (0 to 20). Examples: school, class, amount due, meeting date.
3. A box appears for each variable: give it a name (for example `School`). Leave it empty to keep `Variable 1`, `Variable 2`…
4. Click **Download Excel template**. You get `contacts-template.xlsx` with these columns: **Prefix, First Name, Last Name, Country Code, WhatsApp Number**, then your variables. A second sheet, **Instructions**, explains each column.
5. Fill in one person per row, save, and drop the file back into box 2.

In the message, each variable is used with its name between double braces: `{{School}}`, `{{Variable 1}}`.

Names such as *Phone*, *Mobile*, *Nom* or *Prénom* are refused because the app would mistake them for the name or number columns. Pick another name and try again.

### How the file should look

One line per person, with a header row on top. This is the teachers list layout, which works as is:

| Name | Whatsapp | Prefix | Last Name | School | Country Code |
| --- | --- | --- | --- | --- | --- |
| Rita | 70 123 456 | Mrs | Khoury | Lycée A | |
| Pierre | 6 12 34 56 78 | Mr | Martin | Lycée B | 33 |

How each column is used:

- **Name** → first name (`{{firstName}}` or `{{Name}}` in the message).
- **Last Name** → last name (`{{lastName}}`).
- **Prefix** → the title: Mr, Mrs, Ms, Dr… Use it as `{{Prefix}}` in the message. It can be left empty for some people (see Part 5).
- **Whatsapp** → the number to send to.
- **School** → available as `{{School}}` in the message.
- **Country Code** → *optional*. Only needed for numbers written **without** their country code that are **not** from the default country (Lebanon). Write the code alone: `33`, `+33` or `0033` for France, `971` for the Emirates… Leave it empty for Lebanese numbers. A number that already starts with `+` or `00` keeps its own code and this column is ignored for it.

You do not have to add the Country Code column at all if every number is either Lebanese or already written with its `+` code (`+33 6 12 34 56 78`). The column can also be called `Code pays` or `Indicatif`.

A parents list such as `Prénom / Nom / Téléphone / Classe` works the same way. Rules:

- Column names can be in French or English: `Prénom / Nom / Téléphone`, `First name / Last name / Phone`, `Name / Last Name`, `Mobile`, `WhatsApp`, `Nom et Prénom`, `Mobile Père / Mobile Mère`… The app recognises them. If it guesses wrong you can correct it on the page (including which column holds the country code).
- Phone numbers can be written any way: `70 123 456`, `03-123-456`, `+961 70 123 456`, `0096170123456`. Numbers **without** a country code use the Country Code column when it has a value, otherwise the default country chosen on the page (Lebanon by default).
- Any extra column (Prefix, School, Classe, Montant, Date…) can be used in the message as a placeholder.
- A title line above the header (like "Liste des enseignants") is fine, the app skips it.

Two sample files are in the `samples` folder and behind the **Sample** buttons on the page: `teachers-sample.csv` (Name, Whatsapp, Prefix, Last Name, School, Country Code) and `contacts-sample.csv` (Prénom, Nom, Téléphone, Classe).

### Loading it

1. In box **2 – Contacts**, either drag your file onto the dotted area, or click the dotted area and choose the file, or copy the rows in Excel and paste them in the text box on the right, then click **Use pasted rows**.
2. Check the line **Detected columns**: First name, Last name, Phone. If a column is wrong, change it in the drop-downs and click **Apply**.
3. Look at the summary: **N ready**, and possibly **invalid** (bad or missing number) and **duplicate** (same number twice). Only *ready* contacts receive a message. The table shows every line with the reason when something is wrong, with the row number of your file so you can fix it in Excel and load again.
4. If your numbers are not Lebanese, pick the right **Default country** before loading.

---

## Part 5 – Write the message

1. In box **3 – Message**, type your text. Press Enter for new lines, exactly as you want it to appear in WhatsApp.
2. To insert the person's name, click a blue chip such as **{{firstName}}** or type it yourself. Available placeholders:
   - `{{Prefix}}` – the title (Mr, Mrs…); `{{title}}` and `{{civilité}}` work too
   - `{{firstName}}` – first name (the *Name* column)
   - `{{lastName}}` – last name
   - `{{fullName}}` – both
   - `{{School}}`, `{{Classe}}` – or any other column of your file, written like the column title
   - `{{Prefix|colleague}}` – a fallback text used when the value is empty for someone

   Example for the teachers list:

   ```text
   Dear {{Prefix}} {{lastName}},

   This is a reminder that the teachers' meeting for {{School}} takes place on Thursday at 5 pm in the main hall. Please confirm your presence by replying to this message.

   Thank you,
   The administration
   ```

   Rita gets "Dear Mrs Khoury,". If someone's Prefix is empty, the extra space disappears by itself: "Dear Saad,". To write something else in that case, use a fallback: `Dear {{Prefix|colleague}} {{lastName}}` gives "Dear colleague Saad". The preview warns you about contacts with an empty value so you can check them.
3. The **Preview** box shows the message as the first contact will receive it. Change the person in the drop-down to check others.
4. Click **Send a test to myself**. The message arrives in your own WhatsApp (in the chat with yourself) so you can see the final result on a phone. Fix and test again until it is right.

Writing tips that reduce the risk of being reported: say who you are in the first line, keep it short, make it clearly about something the person expects from you, and tell them they can reply.

### Vary the wording (recommended)

WhatsApp notices when the same text is sent to many people. Names alone change only a word or two, so the messages still look identical. To make them really different, give the app a choice of words: write the options inside **single** braces, separated by a vertical bar `|`. Each teacher gets one option, picked at random.

| You write | Teachers receive one of |
| --- | --- |
| `{Bonjour\|Bonsoir\|Cher collègue}` | "Bonjour", "Bonsoir" or "Cher collègue" |
| `{La réunion aura lieu\|Nous nous retrouverons} jeudi à 17h.` | "La réunion aura lieu jeudi à 17h." or "Nous nous retrouverons jeudi à 17h." |
| `jeudi à 17h. {\|Merci de confirmer votre présence.}` | the sentence alone, or followed by "Merci de confirmer votre présence." (an empty option means "nothing") |

To insert one quickly, select some words in the message and click the dashed chip **{ variation | … }**: your words become the first option and you type the second one. Without a selection it inserts `{Bonjour|Bonsoir}` for you to edit.

Example for the teachers list:

```text
{Bonjour|Bonsoir|Cher collègue} {{Prefix}} {{lastName}},

{La réunion des enseignants|Le conseil pédagogique} de {{School}} {aura lieu|se tiendra} jeudi à 17h en salle 12.
{Merci de confirmer votre présence en répondant à ce message.|Pouvez-vous confirmer votre présence par un simple « OK » ?}

{Bien cordialement|Merci et à jeudi},
L'administration
```

This one message gives 3 × 2 × 2 × 2 × 2 = **48 different versions**. The line under the message box shows how many versions yours has. If it says everyone gets the same text, add a few choices.

Good to know:

- Vary the greeting, the closing and one or two sentences. **Never vary the facts** (date, time, place, amounts): every option must say the same thing.
- Each option must read correctly in the sentence, including agreement: write "La réunion … aura lieu" and "Le conseil … se tiendra" as whole options rather than mixing a feminine subject with a masculine one.
- Placeholders can go inside options: `{Bonjour {{firstName}}|Bonsoir {{Prefix}} {{lastName}}}`.
- Spaces around the `|` do not matter: `{Bonjour | Bonsoir}` works too.
- Each teacher always gets the same version of a given message, so the **Preview** and **Send a test to myself** show exactly what that person will receive. Pick different people in the preview drop-down to see other versions.
- Double braces `{{ }}` are placeholders, single braces `{ | }` are choices. Braces without a `|` inside stay as written.
- If you forget the closing `}`, the preview warns you.

Variations make messages less alike, which helps, but they do **not** prevent a ban on their own: the most important points are in Part 10.

---

## Part 6 – Settings (box 4, "Pacing & safety settings")

The defaults are safe for a personal number. You can leave them as they are.

| Setting | Default | Meaning |
| --- | --- | --- |
| Min / Max delay between messages | 25 / 60 s | A random pause between these two values is made between every two messages. Do not go under 15 s. |
| Messages per batch | 20 | After this many messages the app takes a longer break. |
| Pause between batches | 5 min | Length of that break. |
| Daily limit | 150 | Maximum messages per day, counted across all campaigns on this PC. When reached, the app waits and continues the next morning at 08:00. A new or little-used number should start at 20–30 a day and grow slowly over weeks. |
| Retries per failed message | 1 | How many times a failed message is retried. |
| Pause after N failures in a row | 3 | Safety brake: the campaign pauses itself. |
| Pause after N "not on WhatsApp" in a row | 5 | Same brake for numbers that are not on WhatsApp (can also mean a connection problem). |
| Skip numbers that are not on WhatsApp | on | Checks each number before sending. Keep it on. |
| Show "typing…" | on | Shows the typing indicator for a few seconds before each message, like a person would. |
| Do not send between | off | Quiet hours. Turn it on to be sure nothing goes out at night, for example 21:00 to 08:00. |
| Keep this PC awake | on | Stops Windows from going to sleep while a campaign is running or scheduled (the screen can still turn off). It changes no Windows setting and stops by itself when the campaign ends. |

With the defaults, 100 messages take about 1 h 30. That is intentional.

Changes to these settings apply to the **next** campaign you start, not to one already running.

---

## Part 7 – Send now, or schedule for later

Under the settings, the **When** line lets you choose:

- **Send now** – sending starts as soon as you confirm.
- **Schedule for** – pick a date and time (up to 30 days ahead). The campaign waits and starts by itself at that time.

### Send now

1. Keep **Send now** selected.
2. Check the line under it: how many messages will go out and how long it will take.
3. Click **Start sending** and confirm.
4. Leave the PC on, the black window open, the WhatsApp Chrome window open, and the phone online. You can minimise the windows and do other work.
5. Follow the progress: the green bar, the counter of sent / pending / failed, the countdown to the next message, and the table with one line per contact.

### Schedule for later

1. Prepare everything as usual: contacts loaded, message written and tested.
2. Select **Schedule for** and choose the date and time in the box next to it (it suggests tomorrow 08:30).
3. Check the line under it: it shows when sending starts and how long it will take.
4. Click **Schedule sending** and confirm.
5. Box 4 now shows the badge **scheduled** and a countdown, for example *Scheduled for Thursday 22 October 08:30 (in 14 h 5 min)*. Nothing is sent before that time.
6. At the scheduled time the app starts sending on its own, with the usual delays, batch pauses and daily limit.

For a scheduled campaign to go out, **at the scheduled time**:

- the app must be running (black window open) – do not close it;
- the PC must be on. *Keep this PC awake* (Part 6) stops it from going to sleep, but it cannot stop a shutdown, and on a laptop closing the lid may still put it to sleep: leave the lid open and the charger plugged in;
- the phone must be online.

Good to know:

- **Send now** (button in box 4) cancels the waiting and starts immediately.
- **Pause** / **Resume** keep the scheduled time; **Stop** cancels the campaign.
- If WhatsApp disconnects while waiting, the app keeps trying to reconnect (every 10 minutes after the first attempts) so the campaign is ready on time.
- If the app is closed and reopened **before** the scheduled time, the campaign is still scheduled: it continues by itself once WhatsApp has reconnected.
- If the scheduled time **passed** while the app or the PC was off, nothing is sent automatically. Box 4 tells you so; click **Resume** to send now, or **Stop**.
- If quiet hours are on, or the daily limit is already reached that day, sending starts at the next allowed time.

### While it runs

- **Pause** stops after the current message; **Resume** continues. Pausing and resuming never shortens the delays.
- **Stop** ends the campaign; contacts not yet reached stay unsent.
- If WhatsApp disconnects (phone offline, Wi-Fi drop), the campaign pauses by itself, the app tries to reconnect, and sending resumes automatically. If it gives up, click **Connect**.
- If the campaign pauses with "N failures in a row", check that the phone is online and WhatsApp still works on it, then click **Resume**.

---

## Part 8 – After sending

- **Export results** downloads a CSV with every contact and its status: sent (with the time), failed (with the reason), not on WhatsApp.
- **Retry failed** puts the failed contacts back in the queue (and, if you accept, those reported as not on WhatsApp). Then click **Resume** to send them. A contact marked *Interrupted while sending* may already have received the message: check the chat on your phone before retrying it.
- **New campaign** clears the panel for the next list.
- The **Activity log** at the bottom shows everything that happened, in order.

If the PC was switched off or the app closed during a campaign, the next start shows the unfinished campaign in box 4 with a **Resume** button.

---

## Part 9 – Using it on two PCs (you and your partner)

Each PC runs its own copy: repeat Part 2 and Part 3 on the second PC. Nothing is shared between the two machines; each keeps its own session, settings and daily counter in its `data` folder.

- **Each PC with its own WhatsApp number**: the simplest. Nothing to coordinate.
- **Both PCs with the same number**: WhatsApp allows several linked devices, so each PC scans the same phone. But the daily limit is counted per PC, so set the **Daily limit on each PC to half** (75 and 75 instead of 150), and do not run campaigns on both PCs at the same time.

To update the app later: download the ZIP again and replace all files **except the `data` folder**. If the installation seems broken after an update, delete the `node_modules` folder and double-click `start.cmd` again.

---

## Part 10 – Staying safe (read once, seriously)

WhatsApp is not designed for bulk sending and bans numbers that look like robots. A ban is usually permanent for that number. What triggers it, in order of importance:

1. **People reporting or blocking you.** Only write to people who expect to hear from you (parents, members, customers who gave you their number). Say who you are. Let them answer.
2. **Writing to many people who do not have your number saved.** Ask them to save it (put it in your school communications).
3. **Too many messages, too fast, every day.** Keep the defaults. Spread a big list over several days.
4. **Identical text to everyone.** Names alone are not enough. Use variations (Part 5, "Vary the wording") so the message has dozens of versions, and change the wording between campaigns.
5. **Numbers that are not on WhatsApp.** Keep the check on.
6. **A brand-new number** that immediately broadcasts. Use a number that has had normal conversations for a few weeks, and start with small batches (20–30 a day).

For large or regular volumes, the only method WhatsApp allows is the official WhatsApp Business Platform (paid, with approved templates). This tool uses an unofficial method; it is against WhatsApp's terms of service and you use it at your own risk.

---

## Part 11 – Troubleshooting

| Problem | What to do |
| --- | --- |
| Double-clicking `start.cmd` says Node.js is not installed | Do Part 2, Step 1, then try again. |
| The black window shows "Port 3210 is already in use" | The app is already running in another window. Use that one, or close it first. |
| The page does not open | Type `127.0.0.1:3210` in your browser. |
| No QR code, "Could not start" | Close everything, start again. If it persists, install Google Chrome and start the app with the Chrome path: see "Configuration" in README.md. |
| Stuck on "Loading WhatsApp…" | Wait one minute. Then click **Disconnect**, then **Connect**. |
| A QR code appears although you had linked before | The phone removed this device, or the session expired. Scan again. |
| "Reconnecting…" keeps failing | Make sure the phone is online and open WhatsApp on it once. After five tries the app waits for you to click **Connect**, unless a campaign is waiting (scheduled or paused by the disconnection): then it keeps trying every 10 minutes. |
| Numbers shown as invalid | Check the Default country, or write the numbers with the country code (`+961 70 123 456`). |
| Wrong columns detected | Fix them in **Detected columns** and click **Apply**. |
| Messages fail with a technical error mentioning "evaluate" or "undefined" | WhatsApp Web changed and the library behind the app needs an update: in the project folder run `npm install` again (requires internet), then restart. |
| A scheduled campaign did not go out | The app was closed, the PC was off or asleep, or the phone was offline at that time. Open the app: box 4 says what happened; click **Resume** to send now. |
| "The scheduled time must be at least one minute from now" | The chosen time is in the past or too close. Pick a later time, or choose **Send now**. |

---

## Quick reference – every time

1. Double-click `start.cmd`, wait for the page.
2. Badge green? If not, click **Connect** (scan if asked).
3. Load the contact file, check the columns and the "ready" count.
4. Write the message, check the preview, send a test to yourself.
5. Choose **Send now** or **Schedule for** a date and time; check the line below (number of messages, start, duration).
6. **Start sending** (or **Schedule sending**); keep the app, the PC and the phone on until it has finished.
7. When finished: **Export results**, then **New campaign**.
