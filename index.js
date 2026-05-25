const express = require("express");
const cors    = require("cors");
const admin   = require("firebase-admin");
const fs      = require("fs");
const path    = require("path");
const os      = require("os");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

// ─────────────────────────────
// INIT APP
// ─────────────────────────────
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// ─────────────────────────────
// FIREBASE ADMIN INIT
// ─────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

const db = admin.firestore();

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const RATE_LIMIT_MS  = 3000;
const TIME_LIMIT_MS  = 5000;   // وقت تشغيل كل test case
const MEM_LIMIT_MB   = 256;    // حد الميموري (ulimit)
const MAX_OUTPUT_LEN = 100000; // أقصى حجم output (chars)

// ─────────────────────────────────────────────
// LOCAL C++ RUNNER
// ─────────────────────────────────────────────
async function localRun(code, stdin) {
  // 1. اكتب الكود في ملف مؤقت
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), "judge-"));
  const srcFile = path.join(tmpDir, "solution.cpp");
  const binFile = path.join(tmpDir, "solution");

  try {
    fs.writeFileSync(srcFile, code);

    // 2. Compile
    try {
      await execFileAsync("g++", [
        "-std=c++17", "-O2",
        "-o", binFile,
        srcFile,
      ], { timeout: 10000 });
    } catch (compileErr) {
      return {
        stdout: "",
        stderr: compileErr.stderr || compileErr.message,
        exitCode: 1,
        ce: true,
      };
    }

    // 3. Run مع stdin + time limit + memory limit
    const result = await runWithLimits(binFile, stdin || "");
    return result;

  } finally {
    // 4. نظّف الملفات المؤقتة دايمًا
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function runWithLimits(binFile, stdin) {
  return new Promise((resolve) => {
    // ulimit -v لحد الميموري (KB)
    const child = spawn("bash", [
      "-c",
      `ulimit -v ${MEM_LIMIT_MB * 1024} && exec "${binFile}"`,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "", stderr = "";
    let killed = false;

    // Time limit
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, TIME_LIMIT_MS);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
      // إلغاء لو الـ output كبير جدًا
      if (stdout.length > MAX_OUTPUT_LEN) {
        killed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? 1,
        tle: killed,
        ce: false,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: err.message, exitCode: 1, ce: false, tle: false });
    });
  });
}

// ─────────────────────────────────────────────
// CLASSIFY
// ─────────────────────────────────────────────
function classifyResult(result, expectedOutput) {
  if (result.ce)                           return "CE";
  if (result.tle)                          return "TLE";
  if (result.stderr && result.stderr.trim()) return "RE";
  if (result.exitCode !== 0)               return "RE";
  return result.stdout.trim() === (expectedOutput || "").trim() ? "AC" : "WA";
}

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok" }));

// ─────────────────────────────────────────────
// JUDGE ENDPOINT
// ─────────────────────────────────────────────
app.post("/judgeSubmission", async (req, res) => {

  // ── 1. Auth ──
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing authorization token" });
  }
  const idToken = authHeader.split("Bearer ")[1];
  let uid, email;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid   = decoded.uid;
    email = decoded.email || "";
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  // ── 2. Parse body ──
  const { contestId, problemId, code } = req.body;
  if (!contestId || !problemId || !code) {
    return res.status(400).json({ error: "Missing contestId, problemId, or code" });
  }

  // ── 3. Rate limiting ──
  try {
    const userRef    = db.collection("users").doc(uid);
    const userSnap   = await userRef.get();
    const lastSubmit = userSnap.data()?.lastSubmit?.toMillis?.() || 0;
    if (Date.now() - lastSubmit < RATE_LIMIT_MS) {
      return res.status(429).json({ error: "Too many requests — wait a moment" });
    }
    await userRef.update({ lastSubmit: admin.firestore.FieldValue.serverTimestamp() });
  } catch { /* مش هنوقف لو فشل */ }

  // ── 4. Contest validation ──
  let contestData;
  try {
    const contestSnap = await db.collection("contests").doc(contestId).get();
    if (!contestSnap.exists) return res.status(404).json({ error: "Contest not found" });
    contestData = contestSnap.data();
  } catch (e) {
    return res.status(500).json({ error: `Firestore error: ${e.message}` });
  }

  const now   = Date.now();
  const start = contestData.startTime?.toMillis?.() || contestData.startTime;
  const end   = contestData.endTime?.toMillis?.()   || contestData.endTime;
  if (now < start) return res.status(403).json({ error: "Contest has not started yet" });
  if (now > end)   return res.status(403).json({ error: "Contest has ended" });

  const isAdminUser  = contestData.admins?.includes(uid);
  const isRegistered = contestData.registeredUsers?.includes(uid);
  if (!isAdminUser && !isRegistered) {
    return res.status(403).json({ error: "You are not registered for this contest" });
  }

  // ── 5. Fetch test cases ──
  let hiddenTests = [], publicExamples = [];
  try {
    const probSnap = await db
      .collection("contests").doc(contestId)
      .collection("problems").doc(problemId)
      .get();

    if (!probSnap.exists) return res.status(404).json({ error: "Problem not found" });
    const probData = probSnap.data();
    hiddenTests    = probData.hiddenTests || [];
    publicExamples = probData.examples   || [];
  } catch (e) {
    return res.status(500).json({ error: `Firestore error: ${e.message}` });
  }

  const testcases  = hiddenTests.length ? hiddenTests : publicExamples;
  const totalTests = testcases.length || 1;

  // ── 6. Compile مرة واحدة ──
  // نعمل compile أول بأول مرة بس، وبعدين نشغّل على كل test case
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), "judge-"));
  const srcFile = path.join(tmpDir, "solution.cpp");
  const binFile = path.join(tmpDir, "solution");
  let compileFailed = false, compileStderr = "";

  try {
    fs.writeFileSync(srcFile, code);
    await execFileAsync("g++", ["-std=c++17", "-O2", "-o", binFile, srcFile], { timeout: 10000 });
  } catch (compileErr) {
    compileFailed  = true;
    compileStderr  = compileErr.stderr || compileErr.message;
  }

  // ── 7. Judge ──
  let passedCount = 0, finalVerdict = "AC", verdictDesc = "Accepted";
  const publicCaseResults = [];

  try {
    if (compileFailed) {
      finalVerdict = "CE";
      verdictDesc  = "Compile Error";
    } else if (testcases.length) {
      for (const tc of testcases) {
        const result  = await runWithLimits(binFile, tc.input || "");
        result.ce     = false; // الـ compile نجح بالفعل
        const verdict = classifyResult(result, tc.output || tc.expectedOutput || "");

        if (verdict === "AC") passedCount++;
        else if (finalVerdict === "AC") {
          finalVerdict = verdict;
          verdictDesc  =
            verdict === "TLE" ? "Time Limit Exceeded" :
            verdict === "RE"  ? "Runtime Error"       : "Wrong Answer";
        }

        const isPublicExample = publicExamples.some(ex => ex.input === tc.input);
        if (isPublicExample) {
          publicCaseResults.push({
            verdict,
            input:    tc.input || "",
            expected: tc.output || tc.expectedOutput || "",
            got:      result.stdout,
          });
        }
      }
    } else {
      // مفيش test cases — بس تأكد إنه اتـcompile (فوق نجح)
      passedCount = 1;
    }
  } catch (e) {
    finalVerdict = "ERR";
    verdictDesc  = e.message;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  // ── 8. Write to Firestore ──
  try {
    await db
      .collection("contests").doc(contestId)
      .collection("submissions")
      .add({
        userId: uid, userEmail: email, problemId,
        verdict: finalVerdict, verdictDesc, code,
        submitTime: admin.firestore.FieldValue.serverTimestamp(),
        passedCount, totalTests,
      });
  } catch (e) {
    console.error("Firestore write failed:", e.message);
  }

  return res.status(200).json({ verdict: finalVerdict, verdictDesc, passedCount, totalTests, publicCaseResults });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Judge server running on port ${PORT}`));
