"""Offline end-to-end check of /btw in the real pi TUI (development aid).

Drives pi in a pty with pi-goal and the scripted offline provider
(test/fixtures/offline-provider.ts following test/fixtures/tui-script.json; main-agent
and side requests take the script's steps in order) and renders the screen with pyte:

  /goal execute prompt.md -> progress note + a bash that prints test results -> sleep 60
  -> /btw how close are you to being done? -> check the side request's context
  -> type "push now", Ctrl+N, Enter -> the main agent gets it as a steer
  -> /btw, Ctrl+R -> the answer is in the main editor
  -> /reload, /btw -> the thread is still there.

Usage: python3 test/fixtures/drive-tui.py [output-dir]   (needs `pip install pyte`)
pi-goal is loaded from $PI_GOAL_DIR (default: a pi-goal checkout next to this one).
Screens land in <output-dir>/screens, provider requests in <output-dir>/record, and the
session in <output-dir>/agent/sessions. Uses a fresh agent directory, so none of the
user's installed packages load.
"""
import json, os, pty, select, shutil, subprocess, sys, tempfile, time, pathlib
import fcntl, struct, termios
import pyte

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="pi-btw-tui-"))
FIXTURES = pathlib.Path(__file__).resolve().parent
REPO = FIXTURES.parent.parent
PI_GOAL = pathlib.Path(os.environ.get("PI_GOAL_DIR", REPO.parent / "pi-goal"))
AGENT, WORK, RECORD, SCREENS = ROOT / "agent", ROOT / "work", ROOT / "record", ROOT / "screens"
for d in (AGENT, WORK, RECORD, SCREENS):
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
(AGENT / "settings.json").write_text('{"lastChangelogVersion":"0.87.1","theme":"dark"}\n')
(WORK / "prompt.md").write_text("# Parser\n\nPort the parser, make the tests pass, then push.\n")
git = ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"]
subprocess.run(git + ["init", "-q"], cwd=WORK, check=True)
subprocess.run(git + ["add", "prompt.md"], cwd=WORK, check=True)
subprocess.run(git + ["commit", "-qm", "Add the parser prompt"], cwd=WORK, check=True)
(WORK / "parser.rs").write_text("fn parse() {}\n")

COLS, ROWS = 140, 45
screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)
env = dict(os.environ, PI_CODING_AGENT_DIR=str(AGENT), OFFLINE_RECORD_DIR=str(RECORD),
           OFFLINE_SCRIPT=str(FIXTURES / "tui-script.json"), TERM="xterm-256color", COLUMNS=str(COLS), LINES=str(ROWS))
pid, fd = pty.fork()
if pid == 0:
    os.chdir(WORK)
    os.execvpe("pi", ["pi", "-e", f"{REPO}/src/index.ts", "-e", f"{PI_GOAL}/src/index.ts",
                      "-e", f"{REPO}/test/fixtures/offline-provider.ts", "--model", "offline/echo"], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))


def pump(seconds=0.2):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            stream.feed(data)


def text():
    return "\n".join(line.rstrip() for line in screen.display)


def wait_for(needle, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        pump(0.2)
        if needle in text():
            return True
    raise SystemExit(f"TIMEOUT waiting for {needle!r}\n----\n{text()}")


step_no = 0


def snap(name):
    global step_no
    step_no += 1
    (SCREENS / f"{step_no:02d}-{name}.txt").write_text(text() + "\n")
    print(f"--- {step_no:02d} {name}")
    print(text())
    sys.stdout.flush()


def type_text(s):
    for ch in s:
        os.write(fd, ch.encode())
        pump(0.01)
    pump(0.3)


def type_line(s):
    type_text(s)
    os.write(fd, b"\r")


def requests():
    """Recorded provider requests, in order: (number, context, text)."""
    found = []
    for path in sorted(RECORD.glob("context-*.json"), key=lambda p: int(p.stem.split("-")[1])):
        context = json.loads(path.read_text())
        found.append((int(path.stem.split("-")[1]), context, json.dumps(context)))
    return found


def side_requests():
    return [(n, c) for n, c, raw in requests() if "<side_question>" in raw]


def side_prompt(context):
    """The side request's one user message (pi sends the system prompt as a system message)."""
    users = [m for m in context["messages"] if m.get("role") == "user"]
    content = users[0]["content"] if len(users) == 1 else ""
    return content if isinstance(content, str) else "".join(part.get("text", "") for part in content)


checks = []


def check(name, ok):
    checks.append((name, bool(ok)))
    print(f"CHECK {'ok  ' if ok else 'FAIL'} {name}")


pump(3)
snap("started")
type_line("/goal execute prompt.md")
wait_for("sleep 60", 30)
pump(3)
snap("sleep-running")

type_line("/btw how close are you to being done?")
wait_for("About two thirds", 40)
pump(1)
snap("btw-answer")
sides = side_requests()
check("exactly one side request so far", len(sides) == 1)
n, context = sides[0]
prompt = side_prompt(context)
(ROOT / "side-context.txt").write_text(prompt + "\n")
check("side request is one tool-less user message", not context.get("tools") and [m.get("role") for m in context["messages"]] == ["system", "user"])
check("side request has its own system prompt", "supervising a coding agent" in json.dumps(context))
check("context has the objective", "execute prompt.md" in prompt)
check("context has the progress note", "Parser ported; running the test suite next." in prompt)
check("context has the running sleep", "bash `sleep 60` running for" in prompt)
check("context has the test result key lines", "test result: FAILED. 2 passed; 1 failed" in prompt and "parser::fuzz ... FAILED" in prompt and "exit 101" in prompt)
check("context has live facts for the scratch repo", f"### {WORK.resolve()}" in prompt.replace("/private", "") or "Add the parser prompt" in prompt)
check("context has the dirty file", "?? parser.rs" in prompt)
check("question is last", prompt.rstrip().endswith("<side_question>\nhow close are you to being done?\n</side_question>"))

type_text("push now")
os.write(fd, b"\x0e")  # Ctrl+N
wait_for("Steer the main agent", 20)
pump(1)
snap("steer-editor")
os.write(fd, b"\r")
wait_for("Sent to the main agent", 20)
pump(1)
snap("steer-sent")

# The steer reaches the model once the running tool finishes.
end = time.time() + 120
while time.time() < end and not any("push now" in raw and "<side_question>" not in raw for _, _, raw in requests()):
    pump(0.5)
pump(3)
snap("after-steer")
main_after = [(n, c, raw) for n, c, raw in requests() if "<side_question>" not in raw and "push now" in raw]
check("the steer reached the main agent", len(main_after) > 0)
if main_after:
    n, context, raw = main_after[0]
    (ROOT / "main-context-after-side-question.json").write_text(json.dumps(context, indent=1) + "\n")
    user_texts = [json.dumps(m) for m in context["messages"] if m.get("role") == "user"]
    check("the steer arrived as a user message", any("push now" in t for t in user_texts))
    check("no btw-thread data reached the main agent", "btw-thread" not in raw and "About two thirds" not in raw)

wait_for("Goal complete", 60) if "Goal complete" not in text() else None
pump(2)
type_line("/btw")
wait_for("how close are you to being done?", 20)
pump(1)
snap("btw-reopened")
os.write(fd, b"\x12")  # Ctrl+R
wait_for("Brought back", 20)
pump(1)
snap("brought-back")
check("the main editor holds the brought-back block", "<btw_context>" in text() or "btw_context" in text())

os.write(fd, b"\x03")  # clear the main editor
pump(1)
type_line("/reload")
pump(6)
snap("reloaded")
type_line("/btw")
wait_for("how close are you to being done?", 20)
pump(1)
snap("btw-after-reload")
check("the thread survived /reload", "About two thirds" in text())
os.write(fd, b"\x03")
pump(1)

session_files = list((AGENT / "sessions").rglob("*.jsonl"))
entries = [json.loads(line) for f in session_files for line in f.read_text().splitlines() if line.strip()]
threads = [e for e in entries if e.get("type") == "custom" and e.get("customType") == "btw-thread"]
check("btw-thread entries are custom entries", len(threads) >= 1)
check("no btw-thread custom_message entries", not any(e.get("type") == "custom_message" and e.get("customType") == "btw-thread" for e in entries))

os.write(fd, b"\x03")
pump(0.5)
os.write(fd, b"\x04")
pump(1)
try:
    os.kill(pid, 9)
except Exception:
    pass
(ROOT / "checks.txt").write_text("\n".join(f"{'ok  ' if ok else 'FAIL'} {name}" for name, ok in checks) + "\n")
failed = [name for name, ok in checks if not ok]
print(f"DRIVER {'OK' if not failed else 'FAILED: ' + ', '.join(failed)}: {ROOT}")
sys.exit(1 if failed else 0)
