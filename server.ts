import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';
import * as pdfParseObj from 'pdf-parse';
const pdfParse = (pdfParseObj as any).default || pdfParseObj;
import mammoth from 'mammoth';
import * as xlsx from 'xlsx';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const PORT = 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(__dirname, 'db.json');

// Ensure directories exist
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Database Helper
interface DocumentRecord {
  id: string;
  originalName: string;
  path: string;
  text: string;
  uploadedAt: string;
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
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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

async function extractText(filePath: string, originalName: string): Promise<string> {
  const ext = path.extname(originalName).toLowerCase();
  
  if (ext === '.pdf') {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text;
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
  } else if (ext === '.txt' || ext === '.csv') {
    return fs.readFileSync(filePath, 'utf-8');
  } else if (ext === '.pptx') {
    // PPTX extraction is complex without heavy libraries. We'll fallback to a notice.
    return "PPTX extraction is currently not supported in this simplified MVP. Please convert to PDF.";
  }
  return "Unsupported file format.";
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // === API ROUTES ===

  // Get uploaded documents
  app.get('/api/documents', (req, res) => {
    const records = getDb().map(r => ({ id: r.id, originalName: r.originalName, uploadedAt: r.uploadedAt }));
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
        uploadedAt: new Date().toISOString()
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
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages format.' });
    }

    const db = getDb();
    
    // Combine all extracted text for context
    // In a real system you would use Embeddings & Vector DB or Gemini File API.
    let contextText = '';
    if (db.length === 0) {
      contextText = "No documents have been uploaded yet. Inform the user they need to upload documents in the Admin panel.";
    } else {
      contextText = db.map((rec, i) => `--- DOCUMENT ${i+1}: ${rec.originalName} ---\n${rec.text}\n`).join('\n\n');
    }

    // To prevent exceeding context limits for large numbers of documents,
    // we strictly use gemini-2.5-pro which has 2M context window.
    // If you ever needed to trim, you would do it here.
    
    const systemInstruction = `
You are an Ecological Check FAQ assistant (生態檢核 FAQ系統專家) for an engineering consulting firm.
You are given a context of extracted text from various uploaded documents.
Respond to the user's questions based EXCLUSIVELY on the provided content. 
DO NOT hallucinate or provide information outside of these documents. 
If the context does not contain enough information to answer the question, politely say:
"依據目前上傳的資料，無法回答此問題。請提供更多相關文件。" (Based on the uploaded documents, I cannot answer this question. Please provide more relevant documents.)

IMPORTANT: Always respond in Traditional Chinese (繁體中文).

<Context>
${contextText}
</Context>
    `;

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: messages,
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.2, // Low temperature for factual RAG responses
        }
      });

      res.json({ response: response.text });
    } catch (error) {
      console.error('Chat error:', error);
      res.status(500).json({ error: 'Failed to generate response.' });
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
