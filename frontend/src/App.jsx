import { useState, useEffect, useRef } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { format } from 'date-fns'

function App() {
  const [message, setMessage] = useState('')
  const [chatHistory, setChatHistory] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [currentStreamedMessage, setCurrentStreamedMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const chatContainerRef = useRef(null)
  const fileInputRef = useRef(null)
  const currentMessageRef = useRef(null)
  const [selectedFolder, setSelectedFolder] = useState(null)
  const [savedChats, setSavedChats] = useState([])

  useEffect(() => {
    // Scroll to bottom when chat history updates
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight
    }
  }, [chatHistory, currentStreamedMessage])

  useEffect(() => {
    // Set up periodic refresh of directory contents when folder is selected
    if (selectedFolder) {
      const refreshInterval = setInterval(async () => {
        await loadChatsFromDirectory(selectedFolder)
      }, 5000)

      // Cleanup interval when folder changes or component unmounts
      return () => clearInterval(refreshInterval)
    }
  }, [selectedFolder])

  const loadChatsFromDirectory = async (dirHandle) => {
    try {
      const chats = []
      for await (const entry of dirHandle.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.json')) {
          const file = await entry.getFile()
          const content = await file.text()
          try {
            const chatData = JSON.parse(content)
            chats.push({
              filename: entry.name,
              lastModified: file.lastModified,
              messageCount: chatData.length,
              firstMessage: chatData[0]?.content?.slice(0, 100),
              data: chatData
            })
          } catch (error) {
            console.error(`Error parsing ${entry.name}:`, error)
          }
        }
      }
      setSavedChats(chats.sort((a, b) => b.lastModified - a.lastModified))
    } catch (error) {
      console.error('Error loading chats:', error)
      setErrorMessage(`Failed to load chats: ${error.message}`)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!message.trim() || isLoading) return

    const userMessage = {
      id: uuidv4(),
      role: 'user',
      content: message.trim(),
      timestamp: new Date().toISOString()
    }

    // Add user message immediately
    setChatHistory(prev => [...prev, userMessage])
    setIsLoading(true)
    setMessage('')
    setErrorMessage('')
    
    // Reset streaming state
    setCurrentStreamedMessage('')
    currentMessageRef.current = {
      id: uuidv4(),
      role: 'assistant',
      error: false,
      content: '',
      timestamp: new Date().toISOString()
    }

    try {
      // Send POST request to chat endpoint
      const response = await fetch('http://localhost:8000/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: userMessage.content
        })
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let accumulatedData = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value)
        const lines = (accumulatedData + chunk).split('\n')
        
        accumulatedData = lines.pop()

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const token = line.slice(6)
            setCurrentStreamedMessage(prev => {
              const newContent = prev + token
              if (currentMessageRef.current) {
                currentMessageRef.current.content = newContent
              }
              return newContent
            })
          }
        }
      }

      // Update this section to properly save the final message
      if (currentMessageRef.current) {
        const finalMessage = {
          ...currentMessageRef.current,
          content: currentMessageRef.current.content,
          timestamp: new Date().toISOString()
        }
        setChatHistory(prev => [...prev, finalMessage])
      }

    } catch (error) {
      console.error('Error:', error)
      handleError(error)
    } finally {
      setCurrentStreamedMessage('')
      currentMessageRef.current = null
      setIsLoading(false)
    }
  }

  const handleError = (error) => {
    // Save any progress we made before the error
    if (currentStreamedMessage) {
      const partialMessage = {
        id: currentMessageRef.current?.id || uuidv4(),
        role: 'assistant',
        content: currentStreamedMessage,
        timestamp: new Date().toISOString(),
        error: false,
        partial: true
      }
      setChatHistory(prev => [...prev, partialMessage])
    }
    
    const errorMsg = {
      id: uuidv4(),
      role: 'assistant',
      content: `Error: ${error.message || 'Unknown error occurred'}`,
      timestamp: new Date().toISOString(),
      error: true
    }
    setChatHistory(prev => [...prev, errorMsg])
    setCurrentStreamedMessage('')
    currentMessageRef.current = null
    setErrorMessage(`Error: ${error.message || 'Unknown error occurred'}`)
    setIsLoading(false)
  }

  const handleSaveChat = () => {
    try {
      const filename = `chat_${format(new Date(), 'yyyyMMdd_HHmmss')}.json`
      const chatData = JSON.stringify(chatHistory, null, 2)
      const blob = new Blob([chatData], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setErrorMessage('')
    } catch (error) {
      console.error('Error saving chat:', error)
      setErrorMessage(`Failed to save chat: ${error.message}`)
    }
  }

  const handleLoadChat = (e) => {
    const file = e.target.files[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      try {
        const loadedHistory = JSON.parse(event.target.result)
        setChatHistory(loadedHistory)
        setErrorMessage('')
        // Reset the file input value after loading
        fileInputRef.current.value = ''
      } catch (error) {
        console.error('Error parsing chat history:', error)
        setErrorMessage(`Failed to load chat: ${error.message}`)
      }
    }
    reader.onerror = (error) => {
      console.error('Error reading file:', error)
      setErrorMessage(`Failed to read file: ${error.message}`)
    }
    reader.readAsText(file)
  }

  const handleFolderSelect = async () => {
    try {
      const dirHandle = await window.showDirectoryPicker({
        id: 'chat-directory',
        mode: 'read',
        startIn: 'downloads' // This is the closest we can get to current directory
      })
      
      setSelectedFolder(dirHandle)
      setErrorMessage('')
      await loadChatsFromDirectory(dirHandle)
    } catch (error) {
      console.error('Error selecting folder:', error)
      if (error.name !== 'AbortError') {
        setErrorMessage(`Failed to read folder: ${error.message}`)
      }
    }
  }

  const loadChatFromSaved = (chatData) => {
    setChatHistory(chatData.data)
    setErrorMessage('')
  }

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Sidebar */}
      <div className="w-80 bg-white shadow-lg overflow-hidden flex flex-col">
        <div className="p-4 border-b space-y-3">
          {/* Add New Chat button */}
          <button
            onClick={() => setChatHistory([])}
            className="w-full px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-700 flex items-center justify-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Chat
          </button>

          <button
            onClick={handleFolderSelect}
            className="w-full px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 flex items-center justify-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            {selectedFolder ? 'Change Folder' : 'Select Chats Folder'}
          </button>
          
          {selectedFolder ? (
            <div className="mt-2 text-sm text-gray-600">
              <div className="font-medium">Current folder:</div>
              <div className="truncate">📂 {selectedFolder.name}</div>
            </div>
          ) : (
            <div className="mt-2 text-xs text-gray-600 space-y-1">
              <p className="font-medium">Looking for your chats?</p>
              <p>Select the <span className="font-mono bg-gray-100 px-1 rounded">chat_conversations</span> folder in the project directory</p>
            </div>
          )}
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {savedChats.map((chat) => (
            <div
              key={chat.filename}
              onClick={() => loadChatFromSaved(chat)}
              className="border rounded-lg p-4 hover:bg-gray-50 cursor-pointer transition-colors"
            >
              <div className="text-sm font-medium text-gray-900 truncate">
                {chat.filename}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {format(chat.lastModified, 'yyyy-MM-dd HH:mm:ss')}
              </div>
              <div className="text-xs text-gray-600 mt-1">
                Messages: {chat.messageCount}
              </div>
              {chat.firstMessage && (
                <div className="text-xs text-gray-500 mt-2 line-clamp-2">
                  {chat.firstMessage}...
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        <header className="bg-white shadow-sm p-4">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <h1 className="text-2xl font-bold text-gray-800">Anemll Backend+WebUI</h1>
            <div className="flex items-center gap-4">
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                isLoading ? 'bg-yellow-100 text-yellow-800' : 'bg-green-100 text-green-800'
              }`}>
                {isLoading ? 'Generating...' : 'Ready'}
              </span>
              <button
                onClick={handleSaveChat}
                disabled={chatHistory.length === 0}
                className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Download Chat
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                onChange={handleLoadChat}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-1 text-sm bg-green-500 text-white rounded hover:bg-green-600"
              >
                Load Chat
              </button>
            </div>
          </div>
        </header>

        {errorMessage && (
          <div className="max-w-4xl mx-auto w-full mt-4 px-4">
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative">
              <strong className="font-bold">Error: </strong>
              <span className="block sm:inline">{errorMessage}</span>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              If the server crashes with GIL errors, try restarting and trying again it until it works
            </p>
          </div>
        )}

        <main className="flex-1 max-w-4xl w-full mx-auto p-4 overflow-hidden flex flex-col">
          <div 
            ref={chatContainerRef}
            className="flex-1 overflow-y-auto space-y-4 pb-4"
          >
            {chatHistory.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg p-4 ${
                    msg.role === 'user'
                      ? 'bg-blue-500 text-white shadow-lg transform hover:scale-[1.02] transition-transform'
                      : msg.error
                      ? 'bg-red-100 text-red-800 border border-red-200'
                      : 'bg-white text-gray-800 shadow-lg hover:shadow-xl transition-shadow'
                  }`}
                >
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                  <div className="text-xs mt-2 flex items-center gap-2">
                    <span className={`${msg.role === 'user' ? 'text-blue-100' : 'text-gray-500'}`}>
                      {format(new Date(msg.timestamp), 'HH:mm:ss')}
                    </span>
                    {msg.partial && (
                      <span className="bg-yellow-100 text-yellow-800 px-1 rounded text-xs">
                        Partial
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {currentStreamedMessage && (
              <div className="flex justify-start">
                <div className="max-w-[80%] bg-white text-gray-800 rounded-lg p-4 shadow-lg animate-pulse">
                  <div className="whitespace-pre-wrap">{currentStreamedMessage}</div>
                  <div className="text-xs text-gray-500 mt-2">
                    {format(new Date(), 'HH:mm:ss')} (Generating...)
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Add helper text here, just before the form */}
          <div className="text-xs text-gray-500 mb-2 px-4">
            NOTE: Model conversation history with chat_full.py is not yet implemented.
            <br></br>
            ON ERROR: If the server crashes with GIL errors, try restarting and trying again it until it works.
      
          </div>

          <form onSubmit={handleSubmit} className="mt-4 bg-white rounded-lg shadow-sm p-4">
            <div className="flex gap-2">
              <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Type your message..."
                className="flex-1 p-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-gray-50"
                disabled={isLoading}
              />
              <button
                type="submit"
                className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                disabled={isLoading || !message.trim()}
              >
                {isLoading ? (
                  <span className="flex items-center gap-2">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                    </svg>
                    Generating...
                  </span>
                ) : (
                  'Send'
                )}
              </button>
            </div>
          </form>
        </main>
      </div>
    </div>
  )
}

export default App
