'use strict';
const { spawn } = require('child_process');

/**
 * Keeps the computer from going to sleep while a campaign is running or
 * scheduled, the same way a video player does. The screen may still turn off.
 *
 * Windows: a hidden PowerShell process calls SetThreadExecutionState
 *          (ES_CONTINUOUS | ES_SYSTEM_REQUIRED). Killing it restores normal sleep.
 * macOS:   `caffeinate -i`.
 * Other:   no-op.
 *
 * Nothing is changed in the system settings: the request ends with the process.
 */
const WINDOWS_SCRIPT = [
  "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
  '$t = Add-Type -MemberDefinition $sig -Name Power -Namespace BroadcastKeepAwake -PassThru',
  // 2147483649 = ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x1)
  'while ($true) { [void]$t::SetThreadExecutionState([uint32]2147483649); Start-Sleep -Seconds 50 }',
].join('\n');

class KeepAwake {
  constructor(options) {
    const o = options || {};
    this.platform = o.platform || process.platform;
    this.log = o.log || (() => {});
    this.child = null;
    this.failed = false;
    process.once('exit', () => this.release());
  }

  get active() {
    return Boolean(this.child);
  }

  set(on) {
    if (on) this.acquire(); else this.release();
  }

  acquire() {
    if (this.child || this.failed) return;
    let cmd = null, args = null;
    if (this.platform === 'win32') {
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')];
    } else if (this.platform === 'darwin') {
      cmd = 'caffeinate';
      args = ['-i'];
    } else {
      return;
    }
    try {
      const child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
      child.on('error', err => {
        this.failed = true;
        if (this.child === child) this.child = null;
        this.log('warn', `Could not keep the computer awake: ${err.message}. Set Windows sleep to "Never" while sending.`);
      });
      child.on('exit', () => { if (this.child === child) this.child = null; });
      this.child = child;
      this.log('info', 'Keeping the computer awake while the campaign is running or scheduled');
    } catch (err) {
      this.failed = true;
      this.log('warn', `Could not keep the computer awake: ${err.message}`);
    }
  }

  release() {
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.kill(); } catch { /* already gone */ }
    }
  }
}

module.exports = KeepAwake;
