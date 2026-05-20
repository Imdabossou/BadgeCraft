import os
import aiosmtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_PASS", "")
FROM_EMAIL = os.getenv("FROM_EMAIL", "noreply@badgecraft.example.com")
BASE_URL = os.getenv("BASE_URL", "https://badgecraft.example.com")


async def send_invite_email(to_email: str, org_name: str, inviter_name: str, invite_code: str):
    if not SMTP_HOST:
        # Email not configured — skip silently (invite link still works)
        print(f"[email] SMTP not configured. Invite link: {BASE_URL}/?invite={invite_code}")
        return

    invite_url = f"{BASE_URL}/?invite={invite_code}"

    html = f"""
    <!DOCTYPE html>
    <html>
    <body style="font-family:sans-serif;max-width:520px;margin:40px auto;color:#1a1a1a">
      <div style="background:#f05537;padding:24px 32px;border-radius:12px 12px 0 0">
        <h1 style="color:white;margin:0;font-size:22px">BadgeCraft</h1>
      </div>
      <div style="border:1px solid #eee;border-top:none;padding:32px;border-radius:0 0 12px 12px">
        <h2 style="margin-top:0">You've been invited!</h2>
        <p><strong>{inviter_name}</strong> has invited you to join <strong>{org_name}</strong> on BadgeCraft.</p>
        <p>Click the button below to accept your invitation and get started:</p>
        <a href="{invite_url}"
           style="display:inline-block;background:#f05537;color:white;padding:12px 28px;
                  border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0">
          Accept Invitation
        </a>
        <p style="color:#666;font-size:13px">Or copy this link: <br><code style="background:#f5f5f5;padding:4px 8px;border-radius:4px">{invite_url}</code></p>
        <p style="color:#999;font-size:12px;margin-top:32px">This invitation expires in 7 days. If you didn't expect this email, you can ignore it.</p>
      </div>
    </body>
    </html>
    """

    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"Invitation to join {org_name} on BadgeCraft"
    msg["From"] = FROM_EMAIL
    msg["To"] = to_email
    msg.attach(MIMEText(html, "html"))

    await aiosmtplib.send(
        msg,
        hostname=SMTP_HOST,
        port=SMTP_PORT,
        username=SMTP_USER,
        password=SMTP_PASS,
        start_tls=True,
    )
