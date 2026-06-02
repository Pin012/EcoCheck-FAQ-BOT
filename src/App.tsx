import React, { useState, useRef, useEffect } from 'react';
import { Send, Copy, Check } from 'lucide-react';
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
  relatedQuestions?: string[];
  clarificationQuestion?: string;
}

interface DocumentInfo {
  id: string;
  originalName: string;
  uploadedAt: string;
  source?: 'upload' | 'local';
}

export default function App() {
  return (
    <div className="flex h-screen bg-[#1B3022] text-[#1B3022] font-sans">
      <div className="flex flex-col w-full h-full">
        <header className="bg-[#1B3022] text-[#F2F5F0] border-b border-[#3A5A40] px-5 py-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <img src="/brand-icon.png" alt="EcoCheck 圖示" className="w-6 h-6 object-contain" />
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

function splitBrTags(text: string) {
  return text.split(/<br\s*\/?>/i);
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
          <table className="min-w-full border border-[#CCD4CD] border-collapse text-sm">
            <thead className="bg-[#CCD4CD]">
              <tr>
                {headerCells.map((cell, cellIndex) => (
                  <th key={cellIndex} className="border border-[#CCD4CD] px-3 py-2 text-left font-semibold text-[#1B3022]">
                    {renderInlineBold(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {headerCells.map((_, cellIndex) => (
                    <td key={cellIndex} className="border border-[#CCD4CD] px-3 py-2 align-top">
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
      const bulletParts = splitBrTags(bulletMatch[1]);
      elements.push(
        <div key={index} className="pl-1">
          •{' '}
          {bulletParts.map((part, partIndex) => (
            <React.Fragment key={partIndex}>
              {partIndex > 0 && <br />}
              {renderInlineBold(part)}
            </React.Fragment>
          ))}
        </div>
      );
      continue;
    }

    const headingMatch = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const headingLevel = headingMatch[1].length;
      const headingParts = splitBrTags(headingMatch[2]);
      const headingClass =
        headingLevel === 1
          ? 'text-xl font-bold'
          : headingLevel === 2
            ? 'text-lg font-bold'
            : 'text-base font-semibold';

      elements.push(
        <div key={index} className={headingClass}>
          {headingParts.map((part, partIndex) => (
            <React.Fragment key={partIndex}>
              {partIndex > 0 && <br />}
              {renderInlineBold(part)}
            </React.Fragment>
          ))}
        </div>
      );
      continue;
    }

    const lineParts = splitBrTags(line);
    elements.push(
      <div key={index}>
        {lineParts.map((part, partIndex) => (
          <React.Fragment key={partIndex}>
            {partIndex > 0 && <br />}
            {renderInlineBold(part)}
          </React.Fragment>
        ))}
      </div>
    );
  }

  return elements;
}

function ChatView() {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'model', parts: [{ text: '您好！歡迎使用生態檢核諮詢系統。請輸入關於生態檢核的任何問題，系統將依據專業規範與法規文件為您提供解答。' }] }
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
        const modelText = typeof data.answer === 'string' ? data.answer : data.response;
        const relatedQuestions = Array.isArray(data.relatedQuestions) ? data.relatedQuestions : [];
        const clarificationQuestion = data.needsClarification ? (data.clarificationQuestion || '') : '';
        setMessages(prev => [
          ...prev,
          {
            role: 'model',
            parts: [{ text: modelText }],
            relatedQuestions,
            clarificationQuestion
          }
        ]);
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
    <div className="flex flex-col h-full w-full bg-[#1B3022]">
      {/* Messages */}
      <div className="chat-scrollbar flex-1 overflow-y-auto px-4 py-4 md:px-8 md:py-6">
        <div className="mx-auto w-full max-w-7xl space-y-4 md:space-y-6">
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
              <div className={cn('flex flex-col gap-2 max-w-[92%] sm:max-w-[84%] lg:max-w-[78%]')}>
                <div
                  className={cn(
                    'px-4 py-3 rounded-xl text-sm sm:text-base leading-7',
                    m.role === 'user'
                      ? 'bg-[#3A5A40] text-[#F2F5F0] rounded-tr-none'
                      : 'bg-[#F2F5F0] border border-[#CCD4CD] text-[#1B3022] rounded-tl-none whitespace-pre-wrap'
                  )}
                >
                  {m.role === 'model' ? renderBasicMarkdown(m.parts[0].text) : m.parts[0].text}
                </div>

                {m.role === 'model' && Array.isArray(m.relatedQuestions) && m.relatedQuestions.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {m.relatedQuestions.map((question, qIndex) => (
                      <button
                        key={`${idx}-rq-${qIndex}`}
                        type="button"
                        onClick={() => setInput(question)}
                        className="rounded-full border border-[#A3B18A] bg-[#F2F5F0] px-3 py-1 text-xs text-[#3A5A40] hover:bg-[#CCD4CD]"
                      >
                        {question}
                      </button>
                    ))}
                  </div>
                )}

                {m.role === 'model' && m.clarificationQuestion && m.clarificationQuestion !== '無' && (
                  <div className="rounded-lg border border-[#FFD700] bg-[#E9EDC9] px-3 py-2 text-sm text-[#1B3022]">
                    需補充確認：{m.clarificationQuestion}
                  </div>
                )}

                {m.role === 'model' && (
                  <button
                    type="button"
                    onClick={() => handleCopy(m.parts[0].text, idx)}
                    className="self-end inline-flex items-center gap-1.5 text-xs text-[#3A5A40] hover:text-[#1B3022] border border-[#CCD4CD] bg-[#F2F5F0] rounded-md px-2 py-1 transition-colors"
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
            <div className="px-4 py-3 rounded-xl bg-[#F2F5F0] border border-[#CCD4CD] text-[#3A5A40] flex items-center gap-2">
              <span className="w-2 h-2 bg-[#A3B18A] rounded-full animate-bounce"></span>
              <span className="w-2 h-2 bg-[#A3B18A] rounded-full animate-bounce [animation-delay:0.2s]"></span>
              <span className="w-2 h-2 bg-[#A3B18A] rounded-full animate-bounce [animation-delay:0.4s]"></span>
            </div>
          </motion.div>
        )}
        <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="px-4 py-4 md:px-8 bg-[#CCD4CD] border-t border-[#A3B18A] shrink-0">
        <form
          onSubmit={handleSubmit}
          className="relative mx-auto flex w-full max-w-7xl items-center bg-[#F2F5F0] border border-[#A3B18A] rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-[#0B8B3D] focus-within:border-[#0B8B3D] transition-all"
        >
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            disabled={isLoading}
            placeholder="請輸入您的問題..."
            className="flex-1 w-full border-0 py-3 md:py-4 pl-4 pr-12 text-sm sm:text-base outline-none bg-transparent text-[#1B3022] placeholder:text-[#588157] disabled:text-[#588157]"
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="absolute right-2 p-2 bg-[#0B8B3D] text-[#F2F5F0] rounded-md hover:bg-[#3A5A40] disabled:bg-[#588157] disabled:hover:bg-[#588157] transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
        <p className="mx-auto max-w-7xl text-center text-xs text-[#588157] mt-2">AI 智能回覆內容僅供參考，實際規範與執行細節請依正式核定文件與專案合約為準。</p>
      </div>
    </div>
  );
}
