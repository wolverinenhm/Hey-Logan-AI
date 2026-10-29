# Android setup — step by step

This guide sets up the **Hey AI Bridge** PWA on an Android phone so you can call your AI agents from anywhere in the house.

## 1. Before you start

- The PC is running `start.cmd` and the console shows a **Pairing link** and a **QR code**.
- The phone and the PC are on the **same Wi-Fi network** (not on the guest network — guest networks usually isolate devices).
- Windows Firewall allows Node.js on **Private** networks. If the phone cannot connect, check this first:
  - Windows Security → Firewall & network protection → Allow an app through firewall → find **Node.js JavaScript Runtime** → tick **Private**.
- You have **Google Chrome** installed on the phone.

## 2. Pair

1. Open Chrome on the phone and scan the console QR code, or type the **pairing link** manually:
   ```
   https://192.168.x.x:8443?token=XXXX-XXXX-XXXX
   ```
2. Chrome shows “Your connection is not private” — this is expected, the certificate is generated on your PC.
   Tap **Advanced** → **Proceed to 192.168.x.x (unsafe)**.
3. The page opens with the app already connected (the token is in the link and saved in the browser).

## 3. Allow the microphone

1. Tap **Start listening** (or the big orb).
2. Chrome asks for microphone permission → **Allow**.
3. The orb starts pulsing and the status says “Listening for wake words…”.

> If the microphone button is disabled or Chrome refuses, the page is not a secure context.
> Use the **https://** URL (not http://), accept the certificate warning, and reload.

## 4. Install it like an app

1. Chrome menu (⋮) → **Add to Home screen** → **Install**.
2. Launch it from the home screen; it opens full-screen without browser chrome.
3. First launch may ask for the microphone permission again — allow it.

## 5. Talk to it

1. Tap the orb / **Start listening** once per session.
2. Say: **“Hey Computer, find my tax PDF in Downloads.”**
3. Wait for: *“Computer here.”* → say your command.
4. The result appears and is spoken back.

Try the full example:

> “Hey Claude Code, please open a new session and start looking for my budget Word document at the Downloads folder.”

(Claude Code must be installed and authenticated on the PC; otherwise the app politely tells you how to install it.)

## 6. Tips

- **Battery:** continuous listening keeps the microphone active. Tap the orb to stop when you don’t need it.
- **Follow-ups:** after a reply, say “open it” within 20 seconds without repeating the wake word (Settings → Voice → allow follow-ups).
- **Push-to-talk:** “Hold to talk” sends one command without a wake word.
- **Different voice:** Settings → Reply voice (uses the phone’s installed TTS voices).
- **When away from home:** use Tailscale or Cloudflare Tunnel for a warning-free HTTPS URL; see the README.
- **If the QR/link stops working after a reboot:** the PC’s LAN IP may have changed. Restart `start.cmd` and rescan the new QR code.

## 7. If Chrome keeps blocking the mic on the self-signed page

Some Chrome versions are strict about certificates for microphone access. Options, best first:

1. **Tailscale Serve** on the PC (valid certificate, private network):
   - Install Tailscale on the PC and phone, log in to the same tailnet.
   - On the PC: `tailscale serve --bg https / http://127.0.0.1:8787`
   - Open the `https://<machine>.<tailnet>.ts.net` URL on the phone.
2. **Cloudflare Tunnel**:
   - `cloudflared tunnel --url http://127.0.0.1:8787`
   - Open the printed `https://…trycloudflare.com` URL on the phone.
   - Keep in mind this URL is public; use a long random token (`HEY_AI_TOKEN`).
3. **Trust the local certificate** on Android:
   - Copy `data/certs/cert.pem` from the PC to the phone (e.g. via email/USB).
   - Settings → Security → Encryption & credentials → Install a certificate → CA certificate → choose the file.
   - Chrome needs a restart; the warning should disappear.
