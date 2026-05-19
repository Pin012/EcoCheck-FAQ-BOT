import React, { useState, useRef, useEffect } from 'react';
import { Send, ShieldAlert, Copy, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Interfaces
interface Message {
  role: 'user' | 'model';
  parts: { text: string }[];
}

interface DocumentInfo {
  id: string;
  originalName: string;
  uploadedAt: string;
  source?: 'upload' | 'local';
}

export default function App() {
  return (
    <div className="flex h-screen bg-slate-100 text-slate-900 font-sans">
      <div className="flex flex-col w-full h-full">
        <header className="bg-slate-900 text-slate-100 border-b border-slate-800 px-5 py-3 flex items-center justify-between shrink-0 shadow-sm">
          <div className="flex items-center gap-3">
            <ShieldAlert className="w-5 h-5 text-emerald-300" />
            <h1 className="font-semibold text-lg tracking-wide">EcoCheck Bot 生態檢核FAQ系統</h1>
          </div>
        </header>

        <main className="flex-1 overflow-hidden relative">
          <ChatView />
        </main>
      </div>
    </div>
  );
}

// === CHAT COMPONENT ===

function renderInlineBold(text: string) {
  const segments = text.split(/(\*\*[^*]+\*\*)/g);
  return segments.map((segment, index) => {
    if (segment.startsWith('**') && segment.endsWith('**')) {
      return <strong key={index}>{segment.slice(2, -2)}</strong>;
    }
    return <React.Fragment key={index}>{segment}</React.Fragment>;
  });
}

function parseTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim());
}

function isTableDivider(line: string) {
  const row = parseTableRow(line);
  return row.length > 0 && row.every(cell => /^:?-{3,}:?$/.test(cell));
}

function renderBasicMarkdown(text: string) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const hasPipe = line.includes('|');

    if (hasPipe && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const headerCells = parseTableRow(line);
      const bodyRows: string[][] = [];

      index += 2;
      while (index < lines.length && lines[index].includes('|')) {
        bodyRows.push(parseTableRow(lines[index]));
        index += 1;
      }

      elements.push(
        <div key={`table-${index}`} className="overflow-x-auto my-2">
          <table className="min-w-full border border-slate-300 border-collapse text-sm">
            <thead className="bg-slate-100">
              <tr>
                {headerCells.map((cell, cellIndex) => (
                  <th key={cellIndex} className="border border-slate-300 px-3 py-2 text-left font-semibold">
                    {renderInlineBold(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {headerCells.map((_, cellIndex) => (
                    <td key={cellIndex} className="border border-slate-300 px-3 py-2 align-top">
                      {renderInlineBold(row[cellIndex] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

      index -= 1;
      continue;
    }

    const bulletMatch = line.match(/^\s*\*\s+(.*)$/);
    if (bulletMatch) {
      elements.push(
        <div key={index} className="pl-1">
          • {renderInlineBold(bulletMatch[1])}
        </div>
      );
      continue;
    }

    elements.push(<div key={index}>{renderInlineBold(line)}</div>);
  }

  return elements;
}

function ChatView() {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'model', parts: [{ text: '您好！歡迎使用生態檢核智能諮詢系統。請輸入您關於生態檢核的任何問題，系統將依據專業規範與專案文件為您提供精準、可靠的解答。' }] }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  const handleCopy = async (text: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(idx);
      setTimeout(() => setCopiedIndex(current => (current === idx ? null : current)), 1500);
    } catch {
      setCopiedIndex(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMsg: Message = { role: 'user', parts: [{ text: input.trim() }] };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [...messages, userMsg] })
      });

      const data = await res.json();

      if (res.ok) {
        setMessages(prev => [...prev, { role: 'model', parts: [{ text: data.response }] }]);
      } else {
        setMessages(prev => [...prev, { role: 'model', parts: [{ text: `系統錯誤: ${data.error}` }] }]);
      }
    } catch (err) {
      setMessages(prev => [...prev, { role: 'model', parts: [{ text: '連接伺服器失敗，請稍後再試。' }] }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full max-w-4xl mx-auto w-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4 md:space-y-6">
        <AnimatePresence initial={false}>
          {messages.map((m, idx) => (
            <motion.div
              key={idx}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn(
                'flex w-full',
                m.role === 'user' ? 'justify-end' : 'justify-start'
              )}
            >
              <div className={cn('flex flex-col gap-2 max-w-[88%] sm:max-w-[78%]')}>
                <div
                  className={cn(
                    'px-4 py-3 rounded-xl shadow-sm text-sm sm:text-base leading-7',
                    m.role === 'user'
                      ? 'bg-emerald-700 text-white rounded-tr-none'
                      : 'bg-white border border-slate-300 text-slate-800 rounded-tl-none whitespace-pre-wrap'
                  )}
                >
                  {m.role === 'model' ? renderBasicMarkdown(m.parts[0].text) : m.parts[0].text}
                </div>

                {m.role === 'model' && (
                  <button
                    type="button"
                    onClick={() => handleCopy(m.parts[0].text, idx)}
                    className="self-end inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-slate-900 border border-slate-300 bg-white rounded-md px-2 py-1 transition-colors"
                    aria-label="複製回覆內容"
                  >
                    {copiedIndex === idx ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedIndex === idx ? '已複製' : ''}
                  </button>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {isLoading && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-start">
            <div className="px-4 py-3 rounded-xl bg-white border border-slate-300 text-slate-500 shadow-sm flex items-center gap-2">
              <span className="w-2 h-2 bg-slate-300 rounded-full animate-bounce"></span>
              <span className="w-2 h-2 bg-slate-300 rounded-full animate-bounce [animation-delay:0.2s]"></span>
              <span className="w-2 h-2 bg-slate-300 rounded-full animate-bounce [animation-delay:0.4s]"></span>
            </div>
          </motion.div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 bg-slate-100 border-t border-slate-300 shrink-0">
        <form
          onSubmit={handleSubmit}
          className="relative flex items-center shadow-sm bg-white border border-slate-400 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-emerald-700 focus-within:border-emerald-700 transition-all"
        >
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            disabled={isLoading}
            placeholder="請輸入關於生態檢核的問題..."
            className="flex-1 w-full border-0 py-3 md:py-4 pl-4 pr-12 text-sm sm:text-base outline-none bg-transparent disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="absolute right-2 p-2 bg-emerald-700 text-white rounded-md hover:bg-emerald-800 disabled:opacity-50 disabled:hover:bg-emerald-700 transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
        <p className="text-center text-xs text-slate-500 mt-2">AI 智能回覆內容僅供參考，實際規範與執行細節請依正式核定文件與專案合約為準。</p>
      </div>
    </div>
  );
}
