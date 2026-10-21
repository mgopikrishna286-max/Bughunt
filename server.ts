import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { initDataStore, registerUser, loginUser, getUserByToken, logoutUser, getUserById, recordFailedAttempt, reviveUserWithCoins, restartUserSession, recordChallengeSuccess, getLeaderboard, buyPerk, usePerk, getMongoStatus, connectToMongo, disconnectFromMongo, syncLocalDataToMongo } from './server/dataStore.js';
import { ALL_CHALLENGES } from './server/challengesData.js';
import { ALL_BADGES } from './server/badgesData.js';
import { executeChallengeInSandbox } from './server/codeRunner.js';
import { SandboxInfo } from './src/types/game.js';

const app = express();
const PORT = 3000;

app.use(express.json());

// Initialize persistent database
initDataStore();

// Auth Middleware
function authenticateUser(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }
  const token = authHeader.split(' ')[1];
  const user = getUserByToken(token);
  if (user) {
    (req as any).user = user;
    (req as any).token = token;
  }
  next();
}

app.use(authenticateUser);

// ----------------------------------------------------
// AUTHENTICATION ROUTES
// ----------------------------------------------------
app.post('/api/auth/register', (req: Request, res: Response) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required.' });
    }
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: 'Username must be between 3 and 20 characters.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const result = registerUser(username.trim(), email.trim(), password);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Registration failed.' });
  }
});

app.post('/api/auth/login', (req: Request, res: Response) => {
  try {
    const { usernameOrEmail, password } = req.body;
    if (!usernameOrEmail || !password) {
      return res.status(400).json({ error: 'Username/email and password are required.' });
    }
    const result = loginUser(usernameOrEmail.trim(), password);
    res.json(result);
  } catch (err: any) {
    res.status(401).json({ error: err.message || 'Authentication failed.' });
  }
});

app.post('/api/auth/demo-login', (req: Request, res: Response) => {
  try {
    const { demoUserId } = req.body;
    const targetId = demoUserId || 'usr_neo';
    const user = getUserById(targetId);
    if (!user) {
      return res.status(404).json({ error: 'Demo user not found.' });
    }
    // Create temporary session token
    const token = 'tok_demo_' + targetId + '_' + Date.now();
    // Simulate login
    const result = { user, token };
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  res.json({ user });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  const token = (req as any).token;
  if (token) {
    logoutUser(token);
  }
  res.json({ success: true });
});

// ----------------------------------------------------
// CHALLENGES ROUTES
// ----------------------------------------------------
app.get('/api/challenges', (req: Request, res: Response) => {
  const user = (req as any).user;
  const unlockedLevel = user ? user.stats.unlockedLevel : 1;
  const solvedIds = user ? new Set(user.stats.solvedChallengeIds) : new Set<string>();

  const list = ALL_CHALLENGES.map(c => {
    // Hide solution and deep explanation in list view to prevent cheating
    const { correctCode: _, explanation: __, ...safe } = c;
    return {
      ...safe,
      isUnlocked: c.level <= unlockedLevel,
      isSolved: solvedIds.has(c.id)
    };
  });

  res.json({ challenges: list, unlockedLevel });
});

app.get('/api/challenges/daily', (req: Request, res: Response) => {
  const user = (req as any).user;
  const daily = ALL_CHALLENGES.find(c => c.isDaily);
  if (!daily) {
    return res.status(404).json({ error: 'Daily challenge unavailable.' });
  }
  const solvedIds = user ? new Set(user.stats.solvedChallengeIds) : new Set<string>();
  const { correctCode: _, explanation: __, ...safe } = daily;
  res.json({ challenge: safe, isSolved: solvedIds.has(daily.id) });
});

app.get('/api/challenges/:id', (req: Request, res: Response) => {
  const challenge = ALL_CHALLENGES.find(c => c.id === req.params.id);
  if (!challenge) {
    return res.status(404).json({ error: 'Challenge not found.' });
  }

  const user = (req as any).user;
  const isSolved = user ? user.stats.solvedChallengeIds.includes(challenge.id) : false;

  // Only expose explanation if already solved or in safe mode
  const { correctCode: _, explanation, ...safe } = challenge;
  res.json({
    challenge: {
      ...safe,
      explanation: isSolved ? explanation : undefined
    },
    isSolved
  });
});

app.post('/api/challenges/:id/run', (req: Request, res: Response) => {
  const challenge = ALL_CHALLENGES.find(c => c.id === req.params.id);
  if (!challenge) {
    return res.status(404).json({ error: 'Challenge not found.' });
  }

  const { code, isSubmitting, hintsUsed = 0, timeRemainingSeconds = 0 } = req.body;
  if (typeof code !== 'string') {
    return res.status(400).json({ error: 'Code must be a string.' });
  }

  // Execute in isolated sandbox
  const runResult = executeChallengeInSandbox(code, challenge);

  const user = (req as any).user;

  // If this was an explicit submission or run attempt
  if (!runResult.passed) {
    // Deduct a life if user is authenticated and lives > 0
    if (user && user.id) {
      const { livesRemaining } = recordFailedAttempt(user.id);
      runResult.livesRemaining = livesRemaining;
    }
  } else if (isSubmitting && user && user.id) {
    // Record victory
    const award = recordChallengeSuccess(user.id, challenge.id, hintsUsed, timeRemainingSeconds);
    runResult.pointsEarned = award.pointsEarned;
    runResult.coinsEarned = award.coinsEarned;
    runResult.xpEarned = award.xpEarned;
    runResult.newBadgesUnlocked = award.newBadges;
    runResult.explanation = challenge.explanation;

    // Suggest next challenge in progression
    const nextChallenge = ALL_CHALLENGES.find(c => c.level === challenge.level && c.id !== challenge.id && !award.user.stats.solvedChallengeIds.includes(c.id));
    if (nextChallenge) {
      runResult.nextChallengeId = nextChallenge.id;
    }
  }

  // If passed, reveal explanation
  if (runResult.passed) {
    runResult.explanation = challenge.explanation;
  }

  res.json(runResult);
});

// ----------------------------------------------------
// USER & STATS ROUTES
// ----------------------------------------------------
app.post('/api/user/revive', (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    return res.status(401).json({ error: 'Authentication required to revive.' });
  }
  const result = reviveUserWithCoins(user.id);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

app.post('/api/user/restart', (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const result = restartUserSession(user.id);
  res.json(result);
});

app.post('/api/user/buy-perk', (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const { perkId } = req.body;
  if (!perkId) {
    return res.status(400).json({ error: 'perkId is required' });
  }
  const result = buyPerk(user.id, perkId);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

app.post('/api/user/use-perk', (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const { perkId } = req.body;
  if (!perkId) {
    return res.status(400).json({ error: 'perkId is required' });
  }
  const result = usePerk(user.id, perkId);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

// ----------------------------------------------------
// LEADERBOARD & BADGES ROUTES
// ----------------------------------------------------
app.get('/api/leaderboard', (_req: Request, res: Response) => {
  const leaderboard = getLeaderboard();
  res.json({ leaderboard });
});

app.get('/api/badges', (_req: Request, res: Response) => {
  res.json({ badges: ALL_BADGES });
});

// ----------------------------------------------------
// SYSTEM & SANDBOX SPECIFICATION
// ----------------------------------------------------
app.get('/api/system/sandbox-info', (_req: Request, res: Response) => {
  const info: SandboxInfo = {
    engine: 'Isolated AST & VM Scope Guard with Loop Timeout Sanitizer',
    mode: 'isolated_ast_eval',
    timeoutLimitMs: 1000,
    memoryLimitMb: 32,
    networkAccess: false,
    disallowedTokens: [
      'process', 'child_process', 'fs', 'eval', 'Function', 'require',
      'import', 'fetch', 'XMLHttpRequest', 'WebSocket', 'global'
    ],
    securityNotice: 'Player code runs inside an isolated lexical closure with masked global tokens and strict deep-equality assertions. In production, an external ephemeral container or WebAssembly sandbox (e.g. QuickJS / gVisor) is configured.'
  };
  res.json(info);
});

// ----------------------------------------------------
// MONGODB STATUS & MANAGEMENT ROUTES
// ----------------------------------------------------
app.get('/api/system/mongo-status', async (_req: Request, res: Response) => {
  try {
    const status = await getMongoStatus();
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to retrieve MongoDB status' });
  }
});

app.post('/api/system/mongo-connect', async (req: Request, res: Response) => {
  try {
    const { uri, databaseName = 'bughunt' } = req.body;
    if (!uri || typeof uri !== 'string') {
      return res.status(400).json({ error: 'Valid MongoDB URI is required (e.g., mongodb+srv://... or mongodb://...)' });
    }
    const result = await connectToMongo(uri.trim(), databaseName.trim());
    const status = await getMongoStatus();
    res.json({ ...result, status });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'MongoDB connection failed' });
  }
});

app.post('/api/system/mongo-disconnect', async (_req: Request, res: Response) => {
  try {
    await disconnectFromMongo();
    const status = await getMongoStatus();
    res.json({ success: true, message: 'Disconnected from MongoDB', status });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Disconnect failed' });
  }
});

app.post('/api/system/mongo-sync', async (_req: Request, res: Response) => {
  try {
    const count = await syncLocalDataToMongo();
    const status = await getMongoStatus();
    res.json({ success: true, count, status });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'MongoDB sync failed' });
  }
});

// ----------------------------------------------------
// DEV SERVER & STATIC SERVE
// ----------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve('dist/index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Bug Hunter Server] Online and listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
