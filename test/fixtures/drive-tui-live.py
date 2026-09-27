"""Live end-to-end check of /btw in the real pi TUI through claude-bridge (development aid).

Makes live model calls for the main agent and the side questions. Starts a goal whose
prompt file says to run `sleep 75; echo done` and then write DONE.txt, asks /btw how close
it is and "what happens after that?" while it sleeps, and waits for the goal to complete.
Checks that both side calls ran with effort=low (bridge debug log), that the second answer
names DONE.txt, and that the goal completes. Uses a fresh agent directory with a copy of
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
(WORK / "prompt.md").write_text(
    "# Wait task\n\n"
    "1. Run exactly one bash command: `sleep 75; echo done`.\n"
    "2. Then write DONE.txt containing that command's output.\n"
    "3. Then call goal_complete with a one-line summary. Do nothing else.\n"
)
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
checks = []
def check(name, ok):
    checks.append((name, bool(ok))); print(f"CHECK {'ok  ' if ok else 'FAIL'} {name}"); sys.stdout.flush()
t0 = time.time()
type_line("/btw how close are you to being done?")
wait_for("btw ·", 20); pump(2); snap("btw-open")
wait_for("Enter send", 120); first = round(time.time() - t0, 1); pump(1); snap("answer-1")
t1 = time.time()
type_line("and what happens after that?")
pump(2); wait_for("Enter send", 120); second = round(time.time() - t1, 1); pump(1); snap("answer-2")
check("the answer to the follow-up names DONE.txt", "DONE.txt" in text().split("and what happens after that?")[-1])
os.write(fd, b"\x03"); pump(2)
wait_for("Goal complete", 240); pump(3); snap("goal-complete")
check("the goal completed", "Goal complete" in text())
check("DONE.txt was written", (WORK / "DONE.txt").exists())
os.write(fd, b"\x03"); pump(0.5); os.write(fd, b"\x04"); pump(1)
try: os.kill(pid, 9)
except Exception: pass
log = (ROOT / "bridge.log").read_text() if (ROOT / "bridge.log").exists() else ""
spawns = [line for line in log.splitlines() if "side call: spawn" in line]
check("both side calls ran with effort=low", len(spawns) == 2 and all("effort=low" in line for line in spawns))
lines = "\n".join(spawns) + f"\nfirst answer {first}s, second answer {second}s\n"
(ROOT / "summary.txt").write_text(lines + "\n".join(f"{'ok  ' if ok else 'FAIL'} {name}" for name, ok in checks) + "\n")
print(lines)
failed = [name for name, ok in checks if not ok]
print(f"LIVE DRIVER {'OK' if not failed else 'FAILED: ' + ', '.join(failed)}: {ROOT}")
sys.exit(1 if failed else 0)
