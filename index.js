const express = require("express");
const cors    = require("cors");
const admin   = require("firebase-admin");
const fetch   = require("node-fetch");

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Firebase Admin — بيستخدم GOOGLE_APPLICATION_CREDENTIALS env var
// أو serviceAccountKey.json لو موجود
let serviceAccount;
try {
 admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  })
});
} catch {
  // على Render: حط GOOGLE_APPLICATION_CREDENTIALS كـ env var
  admin.initializeApp();
}

const db = admin.firestore();

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const RATE_LIMIT_MS   = 3000;
const WANDBOX_TIMEOUT = 10000;

// ─────────────────────────────────────────────
// WANDBOX
// ─────────────────────────────────────────────
async function wandboxRun(code, stdin) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WANDBOX_TIMEOUT);

  try {
    const resp = await fetch("https://wandbox.org/api/compile.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        compiler: "gcc-head",
        options: "-std=c++17 -O2",
        stdin: stdin || "",
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Wandbox HTTP ${resp.status}`);
    const data = await resp.json();
    return {
      stdout: data.program_output || "",
      stderr: (data.compiler_error || "") + (data.program_error || ""),
      code: parseInt(data.status) || 0,
    };
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Time Limit Exceeded");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────
// CLASSIFY
// ─────────────────────────────────────────────
function classifyResult(result, expectedOutput) {
  if (result.stderr && result.stderr.trim()) return "CE";
  if (result.code !== 0)                     return "RE";
  return result.stdout.trim() === (expectedOutput || "").trim() ? "AC" : "WA";
}

// ─────────────────────────────────────────────
// HEALTH CHECK (مهم على Render)
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
    const userRef  = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
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

  const isAdmin      = contestData.admins?.includes(uid);
  const isRegistered = contestData.registeredUsers?.includes(uid);
  if (!isAdmin && !isRegistered) {
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

  // ── 6. Judge ──
  let passedCount = 0, finalVerdict = "AC", verdictDesc = "Accepted";
  const publicCaseResults = [];

  try {
    if (testcases.length) {
      for (const tc of testcases) {
        const result  = await wandboxRun(code, tc.input || "");
        const verdict = classifyResult(result, tc.output || tc.expectedOutput || "");

        if (verdict === "AC") passedCount++;
        else if (finalVerdict === "AC") {
          finalVerdict = verdict;
          verdictDesc  = verdict === "CE" ? "Compile Error" : verdict === "RE" ? "Runtime Error" : "Wrong Answer";
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
      const result = await wandboxRun(code, "");
      finalVerdict = result.stderr?.trim() ? "CE" : "AC";
      verdictDesc  = finalVerdict === "CE" ? "Compile Error" : "Accepted";
      passedCount  = finalVerdict === "AC" ? 1 : 0;
    }
  } catch (e) {
    finalVerdict = e.message === "Time Limit Exceeded" ? "TLE" : "ERR";
    verdictDesc  = e.message;
  }

  // ── 7. Write to Firestore ──
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
