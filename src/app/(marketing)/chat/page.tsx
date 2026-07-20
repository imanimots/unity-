import { ChatUI } from './chat-ui'

export const metadata = { title: 'Messages — Unity' }

export default function ChatPage() {
  return (
    <div className="bg-[#FAF8F5] dark:bg-[#0F0A0A]">
      <ChatUI />
    </div>
  )
}
