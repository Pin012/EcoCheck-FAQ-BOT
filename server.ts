import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import * as xlsx from 'xlsx';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const APP_ROOT = process.cwd();

// Configuration
const PORT = 3000;
const UPLOADS_DIR = path.join(APP_ROOT, 'uploads');
const LOCAL_DOCS_DIR = path.join(APP_ROOT, 'documents');
const DB_FILE = path.join(APP_ROOT, 'db.json');
const FAQ_FILE = path.join(APP_ROOT, 'data', 'faq.json');
const CACHE_FILE = path.join(APP_ROOT, 'data', 'response-cache.json');
const LOG_FILE = path.join(APP_ROOT, 'logs', 'request-log.jsonl');

// Ensure directories exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(LOCAL_DOCS_DIR)) fs.mkdirSync(LOCAL_DOCS_DIR, { recursive: true });
if (!fs.existsSync(path.dirname(FAQ_FILE))) fs.mkdirSync(path.dirname(FAQ_FILE), { recursive: true });
if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

interface DocumentRecord {
  id: string;
  originalName: string;
  path: string;
  text: string;
  uploadedAt: string;
  source: 'upload' | 'local';
}

interface FAQItem {
  id: string;
  question: string;
  keywords: string[];
  answer: string;
  tags?: string[];
  priority?: number;
}

interface ResponseCacheItem {
  question: string;
  answer: string;
  createdAt: string;
  sourceType: 'gemini';
  tokenSavedEstimate: number;
}

interface DocChunk {
  id: string;
  sourceFile: string;
  sectionTitle: string;
  text: string;
  embedding?: number[];
}

function getDb(): DocumentRecord[] {
  if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  return [];
}
function saveDb(data: DocumentRecord[]) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function loadFaq(): FAQItem[] {
  if (!fs.existsSync(FAQ_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(FAQ_FILE, 'utf-8')); } catch { return []; }
}

function loadCache(): ResponseCacheItem[] {
  if (!fs.existsSync(CACHE_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')); } catch { return []; }
}

function saveCache(entries: ResponseCacheItem[]) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(entries.slice(-300), null, 2));
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}]+/gu, '').trim();
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return -1;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function splitMarkdownByHeading(markdown: string, sourceFile: string): DocChunk[] {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const chunks: DocChunk[] = [];
  let sectionTitle = '前言';
  let buffer: string[] = [];

  const flushChunk = () => {
    const body = buffer.join('\n').trim();
    if (!body) return;
    const hardLimit = 1400;
    if (body.length <= hardLimit) {
      chunks.push({ id: `${sourceFile}-${chunks.length + 1}`, sourceFile, sectionTitle, text: body });
    } else {
      const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
      let acc = '';
      for (const p of paragraphs) {
        if ((acc + '\n\n' + p).trim().length > hardLimit && acc.trim()) {
          chunks.push({ id: `${sourceFile}-${chunks.length + 1}`, sourceFile, sectionTitle, text: acc.trim() });
          acc = p;
        } else acc = acc ? `${acc}\n\n${p}` : p;
      }
      if (acc.trim()) chunks.push({ id: `${sourceFile}-${chunks.length + 1}`, sourceFile, sectionTitle, text: acc.trim() });
    }
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushChunk();
      buffer = [];
      sectionTitle = heading[2].trim();
    } else {
      buffer.push(line);
    }
  }
  flushChunk();
  return chunks;
}

// Gemini Initialization
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const PRIMARY_MODEL = 'gemini-2.5-flash';
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-2.0-flash-lite,gemini-2.0-flash,gemini-1.5-flash-8b,gemini-1.5-flash')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

let chunkIndex: DocChunk[] = [];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  },
});
const upload = multer({ storage });

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.txt', '.csv', '.md', '.markdown']);

async function syncLocalDocumentsToDb() {
  const db = getDb();
  const localFiles = fs.readdirSync(LOCAL_DOCS_DIR).filter((file) => {
    const fullPath = path.join(LOCAL_DOCS_DIR, file);
    const ext = path.extname(file).toLowerCase();
    return fs.statSync(fullPath).isFile() && SUPPORTED_EXTENSIONS.has(ext);
  });
  const nextDb: DocumentRecord[] = db.filter((r) => r.source !== 'local' || fs.existsSync(r.path));

  for (const fileName of localFiles) {
    const filePath = path.join(LOCAL_DOCS_DIR, fileName);
    const id = `local-${fileName}`;
    const existing = nextDb.find((record) => record.id === id);
    const stat = fs.statSync(filePath);
    const updatedAt = stat.mtime.toISOString();
    if (existing && existing.uploadedAt === updatedAt) continue;

    const text = await extractText(filePath, fileName);
    const record: DocumentRecord = { id, originalName: fileName, path: filePath, text, uploadedAt: updatedAt, source: 'local' };
    const index = nextDb.findIndex((r) => r.id === id);
    if (index >= 0) nextDb[index] = record; else nextDb.push(record);
  }
  saveDb(nextDb);
}

async function extractText(filePath: string, originalName: string): Promise<string> {
  const ext = path.extname(originalName).toLowerCase();
  if (ext === '.pdf') {
    const dataBuffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: dataBuffer });
    try { const data = await parser.getText(); return data.text; } finally { await parser.destroy(); }
  }
  if (ext === '.docx') return (await mammoth.extractRawText({ path: filePath })).value;
  if (ext === '.xlsx') {
    const workbook = xlsx.readFile(filePath);
    let text = '';
    workbook.SheetNames.forEach((sheetName) => {
      text += `--- Sheet: ${sheetName} ---\n`;
      text += xlsx.utils.sheet_to_txt(workbook.Sheets[sheetName]);
      text += '\n';
    });
    return text;
  }
  if (ext === '.txt' || ext === '.csv' || ext === '.md' || ext === '.markdown') return fs.readFileSync(filePath, 'utf-8');
  return 'Unsupported file format.';
}

async function rebuildChunkIndex() {
  const records = getDb();
  const rawChunks: DocChunk[] = [];
  for (const rec of records) rawChunks.push(...splitMarkdownByHeading(rec.text, rec.originalName));
  if (!rawChunks.length || !GEMINI_API_KEY) { chunkIndex = rawChunks; return; }

  for (const chunk of rawChunks) {
    try {
      const r = await ai.models.embedContent({ model: EMBEDDING_MODEL, contents: chunk.text });
      chunk.embedding = r.embeddings?.[0]?.values || [];
    } catch {
      chunk.embedding = [];
    }
  }
  chunkIndex = rawChunks;
}

function findFaqAnswer(userQuery: string): FAQItem | null {
  const faqs = loadFaq().sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  const normalized = normalizeText(userQuery);
  const exact = faqs.find((f) => normalizeText(f.question) === normalized);
  if (exact) return exact;

  let best: { faq: FAQItem; score: number } | null = null;
  for (const faq of faqs) {
    let score = 0;
    for (const kw of faq.keywords || []) if (userQuery.includes(kw)) score += 1;
    for (const token of faq.question.split(/[\s，。！？；、]/).filter((t) => t.length >= 2)) if (userQuery.includes(token)) score += 0.5;
    if (!best || score > best.score) best = { faq, score };
  }
  return best && best.score >= 1.5 ? best.faq : null;
}

function appendRequestLog(log: Record<string, unknown>) {
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(log)}\n`);
}

function parseRetryDelayMs(error: any): number | null {
  const detailList = Array.isArray(error?.details) ? error.details : [];
  const retryInfo = detailList.find((d: any) => d?.['@type']?.includes('RetryInfo'));
  const retryDelay = retryInfo?.retryDelay;
  if (typeof retryDelay === 'string') {
    const seconds = Number.parseFloat(retryDelay.replace('s', ''));
    if (!Number.isNaN(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  }
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isQuotaError = (error: any) => {
  const statusText = typeof error?.status === 'string' ? error.status : String(error?.status ?? '');
  const messageText = typeof error?.message === 'string' ? error.message : String(error?.message ?? '');
  return statusText.includes('RESOURCE_EXHAUSTED') || messageText.includes('"code":429') || messageText.toLowerCase().includes('quota');
};

async function startServer() {
  await syncLocalDocumentsToDb();
  await rebuildChunkIndex();

  const app = express();
  app.use(express.json());

  app.get('/api/documents', (req, res) => {
    const records = getDb().map((r) => ({ id: r.id, originalName: r.originalName, uploadedAt: r.uploadedAt, source: r.source || 'upload' }));
    res.json({ documents: records });
  });

  app.post('/api/documents', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    try {
      const text = await extractText(req.file.path, req.file.originalname);
      const newRecord: DocumentRecord = { id: req.file.filename, originalName: req.file.originalname, path: req.file.path, text, uploadedAt: new Date().toISOString(), source: 'upload' };
      const db = getDb(); db.push(newRecord); saveDb(db);
      await rebuildChunkIndex();
      res.json({ success: true, document: { id: newRecord.id, originalName: newRecord.originalName, uploadedAt: newRecord.uploadedAt }});
    } catch (error) {
      console.error('Error processing file:', error);
      res.status(500).json({ error: 'Failed to process file.' });
    }
  });

  app.delete('/api/documents/:id', async (req, res) => {
    const { id } = req.params;
    const db = getDb();
    const index = db.findIndex((r) => r.id === id);
    if (index === -1) return res.status(404).json({ error: 'Document not found.' });
    const record = db[index];
    if (record.source === 'local') return res.status(400).json({ error: 'Local documents cannot be deleted via API. Please remove from documents folder.' });
    if (fs.existsSync(record.path)) fs.unlinkSync(record.path);
    db.splice(index, 1);
    saveDb(db);
    await rebuildChunkIndex();
    res.json({ success: true });
  });

  app.post('/api/chat', async (req, res) => {
    const startedAt = Date.now();
    const { messages } = req.body;
    if (!GEMINI_API_KEY) return res.status(500).json({ error: '伺服器尚未設定 GEMINI_API_KEY。請先完成 .env 設定後重啟服務。' });
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Invalid messages format.' });

    const normalizedMessages = messages.filter((m) => m && (m.role === 'user' || m.role === 'model') && Array.isArray(m.parts)).map((m) => ({
      role: m.role,
      parts: m.parts.filter((p) => p && typeof p.text === 'string' && p.text.trim().length > 0).map((p) => ({ text: p.text.trim() }))
    })).filter((m) => m.parts.length > 0);
    while (normalizedMessages.length > 0 && normalizedMessages[0].role !== 'user') normalizedMessages.shift();
    if (!normalizedMessages.length) return res.status(400).json({ error: 'No valid user message provided.' });

    const latestUserMessage = [...normalizedMessages].reverse().find((m) => m.role === 'user');
    const userQuery = latestUserMessage?.parts?.[0]?.text || '';

    const cache = loadCache();
    const normalizedQ = normalizeText(userQuery);
    const cacheHit = cache.find((c) => normalizeText(c.question) === normalizedQ);
    if (cacheHit) {
      appendRequestLog({ at: new Date().toISOString(), inputTokenEstimate: estimateTokens(userQuery), outputTokenEstimate: estimateTokens(cacheHit.answer), responseMs: Date.now() - startedAt, cache: 'hit', faq: 'miss', retrievalChunks: 0 });
      return res.json({ response: cacheHit.answer, metadata: { source: 'cache' } });
    }

    const faqHit = findFaqAnswer(userQuery);
    if (faqHit) {
      appendRequestLog({ at: new Date().toISOString(), inputTokenEstimate: estimateTokens(userQuery), outputTokenEstimate: estimateTokens(faqHit.answer), responseMs: Date.now() - startedAt, cache: 'miss', faq: 'hit', retrievalChunks: 0 });
      return res.json({ response: faqHit.answer, metadata: { source: 'faq', faqId: faqHit.id } });
    }

    let topChunks: DocChunk[] = [];
    try {
      const queryEmbedding = await ai.models.embedContent({ model: EMBEDDING_MODEL, contents: userQuery });
      const qv = queryEmbedding.embeddings?.[0]?.values || [];
      topChunks = chunkIndex.map((chunk) => ({ chunk, sim: cosineSimilarity(qv, chunk.embedding || []) }))
        .filter((x) => x.sim > 0)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, 4)
        .map((x) => x.chunk);
    } catch {
      topChunks = chunkIndex.slice(0, 4);
    }

    const contextText = topChunks.map((c) => `[${c.id}] ${c.sourceFile} > ${c.sectionTitle}\n${c.text}`).join('\n\n');
    const systemInstruction = `你是一位專業的生態檢核顧問，僅依據提供 context 回答。若資料不足，請明確說明不足。回覆使用繁體中文、120字內、最多4點條列。`;

    try {
      const modelCandidates = [PRIMARY_MODEL, ...FALLBACK_MODELS.filter((m) => m !== PRIMARY_MODEL)];
      let lastError: any = null;
      for (const modelName of modelCandidates) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: [{ role: 'user', parts: [{ text: `問題：${userQuery}\n\n參考資料：\n${contextText}` }] }],
            config: { systemInstruction, temperature: 0.2 }
          });
          const answer = response.text || '';
          const inputTokenEstimate = estimateTokens(systemInstruction + userQuery + contextText);
          const outputTokenEstimate = estimateTokens(answer);
          cache.push({ question: userQuery, answer, createdAt: new Date().toISOString(), sourceType: 'gemini', tokenSavedEstimate: inputTokenEstimate });
          saveCache(cache);
          appendRequestLog({ at: new Date().toISOString(), inputTokenEstimate, outputTokenEstimate, responseMs: Date.now() - startedAt, cache: 'miss', faq: 'miss', retrievalChunks: topChunks.length });
          return res.json({ response: answer, metadata: { source: 'gemini', retrievalChunks: topChunks.map((c) => ({ id: c.id, sourceFile: c.sourceFile, sectionTitle: c.sectionTitle })) } });
        } catch (error: any) {
          lastError = error;
          if (!isQuotaError(error)) throw error;
          const retryDelayMs = parseRetryDelayMs(error);
          if (retryDelayMs && retryDelayMs <= 60000) await sleep(retryDelayMs);
        }
      }
      throw lastError || new Error('All Gemini model attempts failed.');
    } catch (error: any) {
      const upstreamMessage = error?.message || '未知錯誤';
      if (isQuotaError(error)) return res.status(429).json({ error: `Gemini 額度不足或暫時超限，請稍後重試。上游訊息: ${upstreamMessage}` });
      res.status(500).json({ error: `Gemini API 錯誤: ${upstreamMessage}` });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, '0.0.0.0', () => console.log(`Server running on http://localhost:${PORT}`));
}

startServer();
