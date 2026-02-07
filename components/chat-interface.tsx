'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Send, RefreshCw, Sparkles } from 'lucide-react';
import { ONBOARDING_MESSAGE, getRandomSampleCvText } from '@/lib/prompts';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/** ===== helpers (client-side CV capture) ===== */
function normalizeNewlines(text: string) {
  return (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function countDateRanges(text: string) {
  const t = normalizeNewlines(text || '');
  const m =
    t.match(/(\b\d{2}[./-]\d{4}\b|\b\d{2}\/\d{4}\b|\b\d{4}\b)\s*[–-]\s*(obecnie|\b\d{2}[./-]\d{4}\b|\b\d{2}\/\d{4}\b|\b\d{4}\b)/gi) ||
    [];
  return m.length;
}

function looksLikeExperiencePaste(text: string) {
  const t = normalizeNewlines(text || '');
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);

  const hasDates =
    /(\b\d{2}[./-]\d{4}\b\s*[–-]\s*(obecnie|\b\d{2}[./-]\d{4}\b))|(\b\d{4}\b\s*[–-]\s*(obecnie|\b\d{4}\b))/i.test(t) ||
    /(\b\d{2}\/\d{4}\b\s*[–-]\s*(obecnie|\b\d{2}\/\d{4}\b))/i.test(t);

  const hasPipe = /\|/.test(t);
  const hasBullets = lines.some((l) => /^[-•*]\s+/.test(l));
  const hasHeadingLikeLine = lines.some((l) => !/^[-•*]/.test(l) && l.length >= 4 && l.length <= 120);

  const looksStructured =
    (hasHeadingLikeLine && hasBullets && lines.length >= 3) ||
    (hasHeadingLikeLine && hasPipe && lines.length >= 2) ||
    (hasDates && lines.length >= 2);

  return looksStructured || (hasDates && t.length > 40);
}

function looksLikeExperiencePasteStrong(text: string) {
  const t = normalizeNewlines(text || '').trim();
  if (!t) return false;
  if (t.length < 80) return false;
  return looksLikeExperiencePaste(t);
}

/**
 * ✅ łapiemy jako “CV paste do pamięci” tylko:
 * - pierwszą wklejkę (messages.length === 1)
 * - albo multi-role paste (>=2 zakresy dat)
 * Dzięki temu odpowiedzi usera typu “wklejam opis roli” nie zanieczyszczają cvText.
 */
function looksLikeMultiRoleExperiencePasteStrong(text: string) {
  if (!looksLikeExperiencePasteStrong(text)) return false;
  return countDateRanges(text) >= 2;
}

function mergeCvText(existing: string, incoming: string) {
  const base = (existing || '').trim();
  const add = (incoming || '').trim();
  if (!add) return base;
  if (!base) return add;

  const key = normalizeNewlines(add).replace(/\s+/g, ' ').trim().toLowerCase();
  const baseKey = normalizeNewlines(base).replace(/\s+/g, ' ').trim().toLowerCase();
  if (baseKey.includes(key)) return base;

  return `${base}\n\n${add}`.trim();
}

const ONBOARDING_EFFECTIVE = (() => {
  let t = ONBOARDING_MESSAGE || '';
  // usuń “anonimizację” jeśli jest w promptach
  t = t.replace(/Uwaga:.*anonimizac.*(\n|$)/i, '').trim();
  // jasno komunikujemy nowy standard
  return `${t}\n\n`;
})();

export function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: ONBOARDING_EFFECTIVE },
  ]);
  const [input, setInput] = useState('');
  const [cvText, setCvText] = useState('');
  const [selectedRoleTitle, setSelectedRoleTitle] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    setError(null);

    // ✅ CV capture:
    // - pierwsza wklejka: ustaw cvText (nawet 1 rola)
    // - kolejne: tylko jeśli to MULTI-ROLE paste (żeby nie zbierać odpowiedzi jako “CV”)
    const isMultiRoleCvPaste = looksLikeMultiRoleExperiencePasteStrong(userMessage);

    let nextCvText = cvText;

    if (!nextCvText && messages.length === 1) {
      nextCvText = userMessage;
      setSelectedRoleTitle('');
    } else if (isMultiRoleCvPaste) {
      nextCvText = mergeCvText(nextCvText, userMessage);
      setSelectedRoleTitle('');
    }

    if (nextCvText !== cvText) {
      setCvText(nextCvText);
    }

    const newMessages: Message[] = [...messages, { role: 'user', content: userMessage }];
    setMessages(newMessages);
    setIsLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages.slice(1), // bez onboarding
          cvText: nextCvText || '',
          selectedRoleTitle: selectedRoleTitle || '',
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to get response');
      }

      setMessages([...newMessages, { role: 'assistant', content: data.assistantText }]);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An error occurred';
      setError(errorMessage);
      console.error('Chat error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleNewChat = () => {
    setMessages([{ role: 'assistant', content: ONBOARDING_EFFECTIVE }]);
    setInput('');
    setCvText('');
    setSelectedRoleTitle('');
    setError(null);
    textareaRef.current?.focus();
  };

  const handleTrySample = () => {
    setError(null);
    setInput(getRandomSampleCvText());
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-screen max-w-4xl mx-auto">
      <header className="flex items-center justify-between px-4 py-3 border-b bg-white sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-blue-600" />
          <h1 className="text-lg font-semibold text-gray-900">CV Impact Architect</h1>
        </div>
        <Button variant="outline" size="sm" onClick={handleNewChat} className="gap-2">
          <RefreshCw className="w-4 h-4" />
          <span className="hidden sm:inline">Nowy czat</span>
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
        {messages.map((message, index) => (
          <div
            key={index}
            className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                message.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-900'
              }`}
            >
              {message.role === 'assistant' ? (
                <div
                  className={
                    'prose prose-sm max-w-none break-words ' +
                    'prose-p:my-0 prose-ul:my-0 prose-ol:my-0 prose-li:my-0 prose-headings:my-0 ' +
                    'prose-ol:list-decimal prose-ol:pl-5 prose-ul:list-disc prose-ul:pl-5 ' +
                    'prose-pre:my-0 prose-pre:p-0 prose-pre:bg-transparent ' +
                    'prose-code:bg-transparent prose-code:p-0'
                  }
                >
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkBreaks]}
                    components={{
                      p: ({ children, ...props }) => (
                        <p className="my-0" {...props}>
                          {children}
                        </p>
                      ),
                      ul: ({ children, ...props }) => (
                        <ul className="my-0 pl-5 list-disc" {...props}>
                          {children}
                        </ul>
                      ),
                      ol: ({ children, ...props }) => (
                        <ol className="my-0 pl-5 list-decimal" {...props}>
                          {children}
                        </ol>
                      ),
                      li: ({ children, ...props }) => (
                        <li className="my-0" {...props}>
                          {children}
                        </li>
                      ),
                      pre: ({ children, ...props }) => (
                        <pre className="my-0 p-0 bg-transparent whitespace-pre-wrap" {...props}>
                          {children}
                        </pre>
                      ),
                      code: ({ children, ...props }) => (
                        <code className="bg-transparent p-0" {...props}>
                          {children}
                        </code>
                      ),
                    }}
                  >
                    {message.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="whitespace-pre-wrap break-words">{message.content}</div>
              )}
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl px-4 py-3 bg-gray-100">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-100" />
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-200" />
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="flex justify-center">
            <div className="max-w-md rounded-lg px-4 py-3 bg-red-50 border border-red-200 text-red-800 text-sm">
              <strong>Błąd:</strong> {error}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="border-t bg-white p-4">
        {messages.length === 1 && (
          <div className="mb-3 flex justify-center">
            <Button variant="outline" size="sm" onClick={handleTrySample} className="gap-2">
              <Sparkles className="w-4 h-4" />
              Try sample
            </Button>
          </div>
        )}

        <div className="flex gap-2">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Wklej swoją sekcję Doświadczenie..."
            className="min-h-[60px] max-h-[200px] resize-none"
            disabled={isLoading}
          />
          <Button
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
            size="icon"
            className="h-[60px] w-[60px] shrink-0"
          >
            <Send className="w-5 h-5" />
          </Button>
        </div>

        <p className="text-xs text-gray-500 mt-2 text-center">
          Enter wysyła wiadomość • Shift+Enter nowa linia
        </p>
      </div>
    </div>
  );
}
