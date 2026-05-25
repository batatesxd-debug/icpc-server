const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(express.json());

// ─────────────────────────────
// CONSTANTS
// ─────────────────────────────
const RATE_LIMIT_MS = 3000;
const WANDBOX_TIMEOUT = 10000;

// ─────────────────────────────
// WANDBOX
// ─────────────────────────────
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
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────
// CLASSIFY
// ─────────────────────────────
function classifyResult(result, expected) {
  if (result.stderr?.trim()) return "CE";
  if (result.code !== 0) return "RE";
  return result.stdout.trim() === (expected || "").trim() ? "AC" : "WA";
}

// ─────────────────────────────
// MAIN ROUTE
// ─────────────────────────────
app.post("/judgeSubmission", async (req, res) => {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing token" });
  }

  const idToken = authHeader.split("Bearer ")[1];

  let uid, email;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
    email = decoded.email || "";
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  const { contestId, problemId, code } = req.body;

  if (!contestId || !problemId || !code) {
    return res.status(400).json({ error: "Missing fields" });
  }

  // ── contest ──
  const contestSnap = await db.collection("contests").doc(contestId).get();
  if (!contestSnap.exists) {
    return res.status(404).json({ error: "Contest not found" });
  }

  const contest = contestSnap.data();

  const now = Date.now();
  if (now < contest.startTime) return res.status(403).json({ error: "Not started" });
  if (now > contest.endTime) return res.status(403).json({ error: "Ended" });

  // ── problem ──
  const probSnap = await db
    .collection("contests")
    .doc(contestId)
    .collection("problems")
    .doc(problemId)
    .get();

  if (!probSnap.exists) {
    return res.status(404).json({ error: "Problem not found" });
  }

  const prob = probSnap.data();
  const tests = prob.hiddenTests || prob.examples || [];

  let passed = 0;
  let verdict = "AC";

  for (const t of tests) {
    const result = await wandboxRun(code, t.input || "");
    const v = classifyResult(result, t.output || "");

    if (v !== "AC" && verdict === "AC") verdict = v;
    if (v === "AC") passed++;
  }

  await db.collection("contests")
    .doc(contestId)
    .collection("submissions")
    .add({
      userId: uid,
      email,
      problemId,
      verdict,
      passedCount: passed,
      totalTests: tests.length,
      submitTime: Date.now(),
    });

  return res.json({
    verdict,
    passedCount: passed,
    totalTests: tests.length,
  });
});

// ─────────────────────────────
// START SERVER (Render)
// ─────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on", PORT));