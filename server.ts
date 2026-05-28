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

// Ensure directories exist
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(LOCAL_DOCS_DIR)) {
  fs.mkdirSync(LOCAL_DOCS_DIR, { recursive: true });
}

// Database Helper
interface DocumentRecord {
  id: string;
  originalName: string;
  path: string;
  text: string;
  uploadedAt: string;
  source: 'upload' | 'local';
}

interface AssistantPayload {
  answer: string;
  relatedQuestions: string[];
  needsClarification: boolean;
  clarificationQuestion: string;
}

function getDb(): DocumentRecord[] {
  if (fs.existsSync(DB_FILE)) {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  }
  return [];
}

function saveDb(data: DocumentRecord[]) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Gemini Initialization
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_KEYS = (process.env.GEMINI_API_KEYS || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);
const API_KEYS = GEMINI_API_KEYS.length > 0 ? GEMINI_API_KEYS : (GEMINI_API_KEY ? [GEMINI_API_KEY] : []);
const PRIMARY_MODEL = 'gemini-2.5-flash';
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-2.0-flash-lite,gemini-2.0-flash,gemini-1.5-flash-8b,gemini-1.5-flash')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

// Multer Setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
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

  const nextDb: DocumentRecord[] = db.filter((record) => {
    if (record.source !== 'local') return true;
    return fs.existsSync(record.path);
  });

  for (const fileName of localFiles) {
    const filePath = path.join(LOCAL_DOCS_DIR, fileName);
    const id = `local-${fileName}`;
    const existing = nextDb.find((record) => record.id === id);
    const stat = fs.statSync(filePath);
    const updatedAt = stat.mtime.toISOString();

    if (existing && existing.uploadedAt === updatedAt) {
      continue;
    }

    const text = await extractText(filePath, fileName);
    const record: DocumentRecord = {
      id,
      originalName: fileName,
      path: filePath,
      text,
      uploadedAt: updatedAt,
      source: 'local'
    };

    const index = nextDb.findIndex((r) => r.id === id);
    if (index >= 0) nextDb[index] = record;
    else nextDb.push(record);
  }

  saveDb(nextDb);
}
async function extractText(filePath: string, originalName: string): Promise<string> {
  const ext = path.extname(originalName).toLowerCase();
  
  if (ext === '.pdf') {
    const dataBuffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: dataBuffer });
    try {
      const data = await parser.getText();
      return data.text;
    } finally {
      await parser.destroy();
    }
  } else if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  } else if (ext === '.xlsx') {
    const workbook = xlsx.readFile(filePath);
    let text = '';
    workbook.SheetNames.forEach((sheetName) => {
      text += `--- Sheet: ${sheetName} ---\n`;
      text += xlsx.utils.sheet_to_txt(workbook.Sheets[sheetName]);
      text += '\n';
    });
    return text;
  } else if (ext === '.txt' || ext === '.csv' || ext === '.md' || ext === '.markdown') {
    return fs.readFileSync(filePath, 'utf-8');
  } else if (ext === '.pptx') {
    // PPTX extraction is complex without heavy libraries. We'll fallback to a notice.
    return "PPTX extraction is currently not supported in this simplified MVP. Please convert to PDF.";
  }
  return "Unsupported file format.";
}


function chunkText(text: string, maxChunkLength = 1200): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChunkLength) {
      chunks.push(paragraph);
      continue;
    }

    for (let i = 0; i < paragraph.length; i += maxChunkLength) {
      chunks.push(paragraph.slice(i, i + maxChunkLength));
    }
  }

  return chunks;
}

function buildContextText(records: DocumentRecord[], userQuery: string): string {
  if (records.length === 0) {
    return 'No documents have been uploaded yet. Inform the user they need to upload documents in the Admin panel.';
  }

  const queryTokens = userQuery
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  const scored: { docName: string; text: string; score: number }[] = [];

  for (const rec of records) {
    const chunks = chunkText(rec.text);
    for (const chunk of chunks) {
      const lower = chunk.toLowerCase();
      let score = 0;
      for (const token of queryTokens) {
        if (lower.includes(token)) score += 1;
      }
      if (score > 0) {
        scored.push({ docName: rec.originalName, text: chunk, score });
      }
    }
  }

  const MAX_CONTEXT_CHARS = 120000;

  if (scored.length === 0) {
    let fallback = '';
    for (const rec of records) {
      const snippet = rec.text.slice(0, 8000);
      fallback += `--- DOCUMENT: ${rec.originalName} ---
${snippet}

`;
      if (fallback.length >= MAX_CONTEXT_CHARS) break;
    }
    return fallback.slice(0, MAX_CONTEXT_CHARS);
  }

  scored.sort((a, b) => b.score - a.score);

  let context = '';
  for (const item of scored) {
    const block = `--- DOCUMENT: ${item.docName} ---
${item.text}

`;
    if (context.length + block.length > MAX_CONTEXT_CHARS) break;
    context += block;
  }

  return context || 'No relevant context found in uploaded documents.';
}

function isQueryRelevantToDocuments(records: DocumentRecord[], userQuery: string): boolean {
  const queryTokens = userQuery
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  if (queryTokens.length === 0) return false;

  for (const rec of records) {
    const textLower = rec.text.toLowerCase();
    let hit = 0;
    for (const token of queryTokens) {
      if (textLower.includes(token)) hit += 1;
      if (hit >= 2) return true;
    }
  }

  return false;
}

function parseRetryDelayMs(error: any): number | null {
  const detailList = Array.isArray(error?.details) ? error.details : [];
  const retryInfo = detailList.find((d: any) => d?.['@type']?.includes('RetryInfo'));
  const retryDelay = retryInfo?.retryDelay;
  if (typeof retryDelay === 'string') {
    const seconds = Number.parseFloat(retryDelay.replace('s', ''));
    if (!Number.isNaN(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isQuotaError(error: any): boolean {
  const statusText = typeof error?.status === 'string' ? error.status : String(error?.status ?? '');
  const messageText = typeof error?.message === 'string' ? error.message : String(error?.message ?? '');
  return statusText.includes('RESOURCE_EXHAUSTED') || messageText.includes('"code":429') || messageText.toLowerCase().includes('quota');
}

function parseAssistantPayload(rawText: string): AssistantPayload {
  const text = (rawText || '').trim();
  let answer = text;
  let relatedQuestions: string[] = [];
  let needsClarification = false;
  let clarificationQuestion = '';

  const answerMatch = text.match(/\[回答\]([\s\S]*?)(?:\n\[相關問題\]|\n\[需補充\]|\n\[反問\]|$)/);
  if (answerMatch?.[1]) {
    answer = answerMatch[1].trim();
  }

  const relatedMatch = text.match(/\[相關問題\]([\s\S]*?)(?:\n\[需補充\]|\n\[反問\]|$)/);
  if (relatedMatch?.[1]) {
    relatedQuestions = relatedMatch[1]
      .split('\n')
      .map((line) => line.replace(/^\s*(?:\d+[\).、]|[-*])\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 3);
  }

  const needsMatch = text.match(/\[需補充\]([\s\S]*?)(?:\n\[反問\]|$)/);
  if (needsMatch?.[1]) {
    const normalized = needsMatch[1].trim();
    needsClarification = ['是', 'yes', 'true', '需要'].some((key) => normalized.toLowerCase().includes(key));
  }

  const clarifyMatch = text.match(/\[反問\]([\s\S]*?)$/);
  if (clarifyMatch?.[1]) {
    clarificationQuestion = clarifyMatch[1].trim();
  }

  return { answer, relatedQuestions, needsClarification, clarificationQuestion };
}

async function startServer() {
  await syncLocalDocumentsToDb();

  const app = express();
  app.use(express.json());

  // === API ROUTES ===

  // Get uploaded documents
  app.get('/api/documents', (req, res) => {
    const records = getDb().map(r => ({ id: r.id, originalName: r.originalName, uploadedAt: r.uploadedAt, source: r.source || 'upload' }));
    res.json({ documents: records });
  });

  // Upload a document
  app.post('/api/documents', upload.single('file'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    try {
      const text = await extractText(req.file.path, req.file.originalname);
      
      const newRecord: DocumentRecord = {
        id: req.file.filename,
        originalName: req.file.originalname,
        path: req.file.path,
        text: text,
        uploadedAt: new Date().toISOString(),
        source: 'upload'
      };

      const db = getDb();
      db.push(newRecord);
      saveDb(db);

      res.json({ success: true, document: { id: newRecord.id, originalName: newRecord.originalName, uploadedAt: newRecord.uploadedAt }});
    } catch (error) {
      console.error('Error processing file:', error);
      res.status(500).json({ error: 'Failed to process file.' });
    }
  });

  // Delete a document
  app.delete('/api/documents/:id', (req, res) => {
    const { id } = req.params;
    const db = getDb();
    const index = db.findIndex(r => r.id === id);
    
    if (index === -1) {
      return res.status(404).json({ error: 'Document not found.' });
    }

    const record = db[index];

    if (record.source === 'local') {
      return res.status(400).json({ error: 'Local documents cannot be deleted via API. Please remove from documents folder.' });
    }

    // Delete file
    if (fs.existsSync(record.path)) {
      fs.unlinkSync(record.path);
    }

    // Remove from DB
    db.splice(index, 1);
    saveDb(db);

    res.json({ success: true });
  });

  // RAG Chat Endpoint
  app.post('/api/chat', async (req, res) => {
    const { messages } = req.body;

    if (API_KEYS.length === 0) {
      return res.status(500).json({ error: '伺服器尚未設定 GEMINI_API_KEY 或 GEMINI_API_KEYS。請先完成 .env 設定後重啟服務。' });
    }

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages format.' });
    }

    const normalizedMessages = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'model') && Array.isArray(m.parts))
      .map((m) => ({
        role: m.role,
        parts: m.parts
          .filter((p) => p && typeof p.text === 'string' && p.text.trim().length > 0)
          .map((p) => ({ text: p.text.trim() }))
      }))
      .filter((m) => m.parts.length > 0);

    while (normalizedMessages.length > 0 && normalizedMessages[0].role !== 'user') {
      normalizedMessages.shift();
    }

    if (normalizedMessages.length === 0) {
      return res.status(400).json({ error: 'No valid user message provided.' });
    }

    const db = getDb();
    const latestUserMessage = [...normalizedMessages].reverse().find((m) => m.role === 'user');
    const userQuery = latestUserMessage?.parts?.[0]?.text || '';

    // Build bounded context to prevent token overflow and API failures on large documents.
    const contextText = buildContextText(db, userQuery);
    const isRelevant = isQueryRelevantToDocuments(db, userQuery);
    
    const systemInstruction = `
你是一位專業的生態檢核顧問，必須先彙整「內部上傳文件」內容再回答。
你會收到多份文件擷取內容，回答時僅可依據這些內容，禁止臆測或補充文件外資訊。
若資料不足，請明確回覆：「經檢視目前已上傳之內部資料，尚不足以提供完整研判。建議補充相關文件或背景資訊後，我們將為您進一步彙整與說明。本FAQ系統僅回答生態檢核相關問題，若您願意，我可協助您改寫為生態檢核情境的提問。」
若使用者問題與文件主題不相關（目前主題為生態檢核），[相關問題] 請改提供 3 題「生態檢核主題導向」問題，不必貼近原始問題。
若使用者問題可在文件找到解答，則 [相關問題] 才提供與該題延伸的 3 題問題。

回覆格式規則：
1) 開頭需標示引用文件名稱，例如：「依據《文件名稱》，......」；若有多份可寫「依據《A》與《B》，......」。
2) 全文使用繁體中文。
3) 回答控制在 120 字內。
4) 必要時可用最多 4 點條列。
5) 語氣自然、專業、精簡明確，避免冗長。
6) 嚴格使用以下區塊輸出，且每個區塊都要有：
[回答]
（主要回答）
[相關問題]
1.（延伸問題1）
2.（延伸問題2）
3.（延伸問題3）
[需補充]
（是 或 否）
[反問]
（若「需補充」為是，請給 1 句具體反問；若否，填「無」）

<Context>
${contextText}
</Context>
<IsRelevantToDocumentTopic>
${isRelevant ? 'yes' : 'no'}
</IsRelevantToDocumentTopic>
    `;

    try {
      const modelCandidates = [PRIMARY_MODEL, ...FALLBACK_MODELS.filter((m) => m !== PRIMARY_MODEL)];
      let lastError: any = null;

      for (const apiKey of API_KEYS) {
        const ai = new GoogleGenAI({ apiKey });
        for (const modelName of modelCandidates) {
          try {
            const response = await ai.models.generateContent({
              model: modelName,
              contents: normalizedMessages,
              config: {
                systemInstruction: systemInstruction,
                temperature: 0.2, // Low temperature for factual RAG responses
              }
            });

            const payload = parseAssistantPayload(response.text || '');
            return res.json(payload);
          } catch (error: any) {
            lastError = error;
            if (!isQuotaError(error)) {
              throw error;
            }

            const retryDelayMs = parseRetryDelayMs(error);
            if (retryDelayMs && retryDelayMs <= 60000) {
              console.warn(`API key (尾碼:${apiKey.slice(-4)}) model ${modelName} quota exhausted. Retry after ${retryDelayMs}ms.`);
              await sleep(retryDelayMs);
            }
          }
        }
      }

      throw lastError || new Error('All Gemini model attempts failed.');
    } catch (error: any) {
      console.error('Chat error details:', {
        message: error?.message,
        status: error?.status,
        code: error?.code,
        details: error?.details
      });

      const upstreamMessage = error?.message || '未知錯誤';
      if (isQuotaError(error)) {
        return res.status(429).json({ error: `Gemini 額度不足或暫時超限，請稍後重試，或在 Google AI Studio 提升配額/改用可用模型。上游訊息: ${upstreamMessage}` });
      }
      res.status(500).json({ error: `Gemini API 錯誤: ${upstreamMessage}` });
    }
  });

  // === VITE MIDDLEWARE ===
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
