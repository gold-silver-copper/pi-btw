"""Live end-to-end check of /btw in the real pi TUI through claude-bridge (development aid).

Makes live model calls for the main agent and the side questions. Starts a goal whose
only step is `sleep 75`, asks /btw how close it is and a follow-up while it sleeps, and
waits for the goal to complete. Uses a fresh agent directory with a copy of
claude-bridge.json; the bridge and pi-goal load from their installed checkouts
($PI_PACKAGES_DIR, default ~/.pi/agent/git/github.com/gold-silver-copper).

Usage: python3 test/fixtures/drive-tui-live.py [output-dir]   (needs `pip install pyte`)
Screens land in <output-dir>/screens and the bridge's debug log in <output-dir>/bridge.log.
"""
import os, pty, select, shutil, subprocess, sys, tempfile, time, pathlib, fcntl, struct, termios
import pyte
ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="pi-btw-live-"))
REPO = pathlib.Path(__file__).resolve().parent.parent.parent
HOME = pathlib.Path.home()
GIT = pathlib.Path(os.environ.get("PI_PACKAGES_DIR", HOME / ".pi/agent/git/github.com/gold-silver-copper"))
AGENT, WORK, SCREENS = ROOT / "agent", ROOT / "work", ROOT / "screens"
for d in (AGENT, WORK, SCREENS):
    shutil.rmtree(d, ignore_errors=True); d.mkdir(parents=True)
(AGENT / "settings.json").write_text('{"lastChangelogVersion":"0.87.1","theme":"dark"}\n')
shutil.copy(HOME / ".pi/agent/claude-bridge.json", AGENT / "claude-bridge.json")
(WORK / "prompt.md").write_text("# Wait task\n\nRun exactly one bash command: `sleep 75; echo done`. When it finishes, call goal_complete with a one-line summary. Do nothing else.\n")
g = ["git", "-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"]
subprocess.run(g + ["init", "-q"], cwd=WORK, check=True); subprocess.run(g + ["add", "."], cwd=WORK, check=True); subprocess.run(g + ["commit", "-qm", "Add the wait task"], cwd=WORK, check=True)
COLS, ROWS = 140, 45
screen = pyte.Screen(COLS, ROWS); stream = pyte.ByteStream(screen)
env = dict(os.environ, PI_CODING_AGENT_DIR=str(AGENT), TERM="xterm-256color", COLUMNS=str(COLS), LINES=str(ROWS), CLAUDE_BRIDGE_DEBUG="1", CLAUDE_BRIDGE_DEBUG_PATH=str(ROOT / "bridge.log"))
pid, fd = pty.fork()
if pid == 0:
    os.chdir(WORK)
    os.execvpe("pi", ["pi", "-e", str(GIT / "pi-claude-bridge"), "-e", str(GIT / "pi-goal"), "-e", str(REPO / "src/index.ts"), "--model", "claude-bridge/claude-opus-5-5"], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
def pump(s=0.2):
    end = time.time() + s
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try: stream.feed(os.read(fd, 65536))
            except OSError: return
def text(): return "\n".join(l.rstrip() for l in screen.display)
def wait_for(needle, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        pump(0.3)
        if needle in text(): return True
    raise SystemExit(f"TIMEOUT {needle!r}\n{text()}")
n = 0
def snap(name):
    global n; n += 1
    (SCREENS / f"{n:02d}-{name}.txt").write_text(text() + "\n"); print(f"--- {n:02d} {name}\n{text()}"); sys.stdout.flush()
def type_line(s):
    for ch in s: os.write(fd, ch.encode()); pump(0.01)
    pump(0.3); os.write(fd, b"\r")
pump(5); snap("started")
type_line("/goal execute prompt.md")
wait_for("sleep 75", 120); pump(5); snap("sleeping")
t0 = time.time()
type_line("/btw how close are you to being done?")
wait_for("btw ·", 20); pump(2); snap("btw-open")
wait_for("Enter send", 120); print("first answer seconds", round(time.time() - t0, 1)); pump(1); snap("answer-1")
t1 = time.time()
type_line("and what happens after that?")
pump(2); wait_for("Enter send", 120); print("second answer seconds", round(time.time() - t1, 1)); pump(1); snap("answer-2")
os.write(fd, b"\x03"); pump(2)
wait_for("Goal complete", 180); pump(3); snap("goal-complete")
os.write(fd, b"\x03"); pump(0.5); os.write(fd, b"\x04"); pump(1)
try: os.kill(pid, 9)
except Exception: pass
print("LIVE DRIVER DONE")
