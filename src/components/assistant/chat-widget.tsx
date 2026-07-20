'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { usePathname } from 'next/navigation'
import {
  MessageCircle, X, Send, Mic, MicOff, Volume2, VolumeX,
  Loader2, RotateCcw,
} from 'lucide-react'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

// Web Speech API types (not in TS lib by default)
interface ISpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  onresult: ((e: ISpeechRecognitionEvent) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}
interface ISpeechRecognitionResult {
  0: { transcript: string }
}
interface ISpeechRecognitionEvent {
  results: ISpeechRecognitionResult[]
}
declare global {
  interface Window {
    SpeechRecognition: new () => ISpeechRecognition
    webkitSpeechRecognition: new () => ISpeechRecognition
  }
}

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="w-2 h-2 rounded-full bg-[#9B8B85] animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  )
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'
  const time = message.timestamp.toLocaleTimeString('en-ZA', {
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-[#8B1A1A] flex items-center justify-center text-white text-[10px] font-bold shrink-0 mr-2 mt-1">
          U
        </div>
      )}
      <div className={`max-w-[80%] ${isUser ? 'items-end' : 'items-start'} flex flex-col gap-0.5`}>
        <div
          className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
            isUser
              ? 'bg-[#8B1A1A] text-white rounded-br-sm'
              : 'bg-white dark:bg-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-bl-sm'
          }`}
        >
          {message.content}
        </div>
        <span className="text-[10px] text-[#9B8B85] px-1">{time}</span>
      </div>
    </div>
  )
}

export function ChatWidget() {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: "Hi! I'm the Unity Assistant. Ask me anything about renting items, listings, payments, KYC, or how the platform works.",
      timestamp: new Date(),
    },
  ])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [voiceOutput, setVoiceOutput] = useState(false)
  const [voiceSupported, setVoiceSupported] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const recognitionRef = useRef<ISpeechRecognition | null>(null)
  const pathname = usePathname()

  useEffect(() => {
    const supported =
      typeof window !== 'undefined' &&
      ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
    setVoiceSupported(supported)
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping])

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [isOpen])

  // Stop listening and synthesis on close
  useEffect(() => {
    if (!isOpen) {
      recognitionRef.current?.stop()
      setIsListening(false)
      if (typeof window !== 'undefined') window.speechSynthesis?.cancel()
    }
  }, [isOpen])

  const speak = useCallback((text: string) => {
    if (!voiceOutput || typeof window === 'undefined') return
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = 1.05
    utterance.pitch = 1.0
    utterance.lang = 'en-ZA'
    window.speechSynthesis.speak(utterance)
  }, [voiceOutput])

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isTyping) return
    setError(null)

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text.trim(),
      timestamp: new Date(),
    }

    setMessages(prev => [...prev, userMessage])
    setInput('')
    setIsTyping(true)

    // Search knowledge base for context (best-effort, non-blocking)
    let knowledgeContext: string | undefined
    try {
      const searchRes = await fetch('/api/assistant/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text }),
      })
      if (searchRes.ok) {
        const { results } = await searchRes.json()
        if (results?.length) {
          knowledgeContext = results.join('\n\n')
        }
      }
    } catch {
      // Non-critical — continue without RAG context
    }

    const allMessages = [
      ...messages,
      userMessage,
    ].map(m => ({ role: m.role, content: m.content }))

    const assistantId = `assistant-${Date.now()}`
    const assistantMessage: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
    }
    setMessages(prev => [...prev, assistantMessage])

    try {
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: allMessages,
          pageUrl: pathname,
          knowledgeContext,
        }),
      })

      if (!res.ok || !res.body) throw new Error('Failed to connect to assistant')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let fullText = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        fullText += chunk
        setMessages(prev =>
          prev.map(m => m.id === assistantId ? { ...m, content: fullText } : m)
        )
      }

      speak(fullText)
    } catch {
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantId
            ? { ...m, content: "Sorry, I'm having trouble connecting right now. Please try again." }
            : m
        )
      )
      setError('Connection failed')
    } finally {
      setIsTyping(false)
    }
  }, [messages, isTyping, pathname, speak])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  const toggleVoice = () => {
    if (!voiceSupported) return

    if (isListening) {
      recognitionRef.current?.stop()
      setIsListening(false)
      return
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    const recognition = new SR()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = 'en-ZA'

    recognition.onresult = (e: ISpeechRecognitionEvent) => {
      const transcript = e.results
        .map(r => r[0].transcript)
        .join('')
      setInput(transcript)
    }

    recognition.onend = () => setIsListening(false)
    recognition.onerror = () => setIsListening(false)

    recognitionRef.current = recognition
    recognition.start()
    setIsListening(true)
  }

  const clearChat = () => {
    setMessages([
      {
        id: 'welcome-new',
        role: 'assistant',
        content: "Hi! I'm the Unity Assistant. Ask me anything about renting items, listings, payments, KYC, or how the platform works.",
        timestamp: new Date(),
      },
    ])
    setError(null)
  }

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setIsOpen(o => !o)}
        aria-label={isOpen ? 'Close assistant' : 'Open Unity Assistant'}
        className={`fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-200 ${
          isOpen
            ? 'bg-[#1A0A0A] dark:bg-[#2A1A1A] text-white rotate-0'
            : 'bg-[#8B1A1A] text-white hover:bg-[#7A1616] hover:scale-105'
        }`}
      >
        {isOpen ? <X size={22} /> : <MessageCircle size={22} />}
        {!isOpen && messages.length > 1 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 bg-[#E03D2F] rounded-full text-[10px] font-bold flex items-center justify-center">
            {Math.min(messages.length - 1, 9)}
          </span>
        )}
      </button>

      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 sm:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Chat panel */}
      <div
        className={`fixed bottom-0 right-0 z-50 flex flex-col
          inset-x-0 sm:inset-x-auto sm:w-[420px]
          h-[90vh] sm:h-[600px]
          sm:bottom-24 sm:rounded-2xl
          bg-[#FAF8F5] dark:bg-[#0F0A0A]
          border border-[#F2EDE8] dark:border-[#2A1A1A]
          shadow-2xl overflow-hidden
          transition-all duration-300 ease-out
          ${isOpen
            ? 'opacity-100 translate-y-0 sm:translate-y-0 pointer-events-auto'
            : 'opacity-0 translate-y-4 sm:translate-y-4 pointer-events-none'
          }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-[#1A0A0A] dark:bg-[#0F0A0A] shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-[#8B1A1A] flex items-center justify-center text-white text-xs font-bold">
              U
            </div>
            <div>
              <div className="text-sm font-extrabold text-white uppercase tracking-tight">Unity Assistant</div>
              <div className="text-[10px] text-[#9B8B85] uppercase tracking-[0.1em]">AI-powered help</div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* Voice output toggle */}
            <button
              onClick={() => {
                setVoiceOutput(v => !v)
                if (voiceOutput && typeof window !== 'undefined') window.speechSynthesis?.cancel()
              }}
              className="p-2 rounded-lg text-[#9B8B85] hover:text-white hover:bg-white/10 transition-colors"
              aria-label={voiceOutput ? 'Disable voice output' : 'Enable voice output'}
              title={voiceOutput ? 'Voice output on' : 'Voice output off'}
            >
              {voiceOutput ? <Volume2 size={16} /> : <VolumeX size={16} />}
            </button>
            {/* Clear chat */}
            <button
              onClick={clearChat}
              className="p-2 rounded-lg text-[#9B8B85] hover:text-white hover:bg-white/10 transition-colors"
              aria-label="Clear conversation"
              title="Clear chat"
            >
              <RotateCcw size={15} />
            </button>
            {/* Close (mobile) */}
            <button
              onClick={() => setIsOpen(false)}
              className="p-2 rounded-lg text-[#9B8B85] hover:text-white hover:bg-white/10 transition-colors sm:hidden"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1 scroll-smooth">
          {messages.map(message => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {isTyping && (
            <div className="flex justify-start mb-3">
              <div className="w-7 h-7 rounded-full bg-[#8B1A1A] flex items-center justify-center text-white text-[10px] font-bold shrink-0 mr-2 mt-1">
                U
              </div>
              <div className="px-3.5 py-2.5 rounded-2xl rounded-bl-sm bg-white dark:bg-[#2A1A1A] border border-[#F2EDE8] dark:border-[#2A1A1A]">
                <TypingDots />
              </div>
            </div>
          )}
          {error && (
            <div className="text-center text-xs text-[#E03D2F] py-2">{error}</div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input bar */}
        <div className="px-3 py-3 border-t border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] shrink-0">
          {!voiceSupported && isListening === false && (
            <p className="text-[10px] text-[#9B8B85] mb-1.5 px-1">
              Voice input not supported in this browser.
            </p>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything about Unity…"
              rows={1}
              className="flex-1 resize-none bg-[#FAF8F5] dark:bg-[#0F0A0A] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl px-3.5 py-2.5 text-sm text-[#1A0A0A] dark:text-[#F5F0ED] placeholder:text-[#9B8B85] focus:outline-none focus:border-[#8B1A1A] focus:ring-1 focus:ring-[#8B1A1A]/20 max-h-28 overflow-y-auto leading-relaxed"
              style={{ minHeight: '42px' }}
            />
            {/* Voice input */}
            {voiceSupported && (
              <button
                onClick={toggleVoice}
                className={`p-2.5 rounded-xl transition-colors shrink-0 ${
                  isListening
                    ? 'bg-[#E03D2F] text-white animate-pulse'
                    : 'bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#8B1A1A] hover:text-white'
                }`}
                aria-label={isListening ? 'Stop listening' : 'Start voice input'}
              >
                {isListening ? <MicOff size={16} /> : <Mic size={16} />}
              </button>
            )}
            {/* Send */}
            <button
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || isTyping}
              className="p-2.5 rounded-xl bg-[#8B1A1A] text-white hover:bg-[#7A1616] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
              aria-label="Send message"
            >
              {isTyping ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
          <p className="text-[10px] text-[#9B8B85] text-center mt-2 uppercase tracking-[0.08em]">
            Press Enter to send · Shift+Enter for new line
          </p>
        </div>
      </div>
    </>
  )
}
