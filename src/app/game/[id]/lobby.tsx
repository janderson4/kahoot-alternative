import { Participant, supabase } from '@/types/types'
import { FormEvent, useEffect, useRef, useState } from 'react'

export default function Lobby({
  gameId,
  onRegisterCompleted,
}: {
  gameId: string
  onRegisterCompleted: (participant: Participant) => void
}) {
  const [participant, setParticipant] = useState<Participant | null>(null)

  useEffect(() => {
    const fetchParticipant = async () => {
      let userId: string | null = null

      const { data: sessionData, error: sessionError } =
        await supabase.auth.getSession()

      if (sessionData.session) {
        userId = sessionData.session?.user.id ?? null
      } else {
        const { data, error } = await supabase.auth.signInAnonymously()
        if (error) console.error(error)
        userId = data?.user?.id ?? null
      }

      if (!userId) {
        return
      }

      const { data: participantData, error } = await supabase
        .from('participants')
        .select()
        .eq('game_id', gameId)
        .eq('user_id', userId)
        .maybeSingle()

      if (error) {
        return alert(error.message)
      }

      if (participantData) {
        setParticipant(participantData)
        onRegisterCompleted(participantData)
      }
    }

    fetchParticipant()
  }, [gameId, onRegisterCompleted])

  return (
    <div className="bg-green-500 flex justify-center items-center min-h-screen">
      <div className="bg-black p-12">
        {!participant && (
          <Register
            gameId={gameId}
            onRegisterCompleted={(participant) => {
              onRegisterCompleted(participant)
              setParticipant(participant)
            }}
          />
        )}

        {participant && (
          <div className="text-white max-w-md">
            <h1 className="text-xl pb-4">Welcome {participant.nickname}！</h1>
            <p>
              You have been registered and your nickname should show up on the
              admin screen. Please sit back and wait until the game master
              starts the game.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function Register({
  onRegisterCompleted,
  gameId,
}: {
  onRegisterCompleted: (player: Participant) => void
  gameId: string
}) {
  const [nickname, setNickname] = useState('')
  const [sending, setSending] = useState(false)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImageFile(file)
    const reader = new FileReader()
    reader.onloadend = () => setImagePreview(reader.result as string)
    reader.readAsDataURL(file)
  }

  const onFormSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setSending(true)

    if (!nickname.trim()) {
      setSending(false)
      return alert('Please enter a nickname')
    }

    if (!imageFile) {
      setSending(false)
      return alert('Please upload a photo of yourself')
    }

    // Upload image to Supabase Storage
    const ext = imageFile.name.split('.').pop() ?? 'jpg'
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('people-photos')
      .upload(fileName, imageFile, { upsert: false, contentType: imageFile.type })

    if (uploadError) {
      setSending(false)
      return alert(`Image upload failed: ${uploadError.message}`)
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from('people-photos').getPublicUrl(uploadData.path)

    // Save to people table
    const { error: peopleError } = await supabase
      .from('people')
      .insert({ name: nickname.trim(), image: publicUrl })

    if (peopleError) {
      // Ignore unique-constraint violations (person already registered)
      if (peopleError.code !== '23505') {
        setSending(false)
        return alert(`Failed to save profile: ${peopleError.message}`)
      }
    }

    // Register as a game participant
    const { data: participant, error } = await supabase
      .from('participants')
      .insert({ nickname: nickname.trim(), game_id: gameId })
      .select()
      .single()

    if (error) {
      setSending(false)
      return alert(error.message)
    }

    // Trigger the combination worker (fire-and-forget — we don't wait for it)
    fetch('/api/generate-combinations', { method: 'POST' }).catch(() => {})

    onRegisterCompleted(participant)
  }

  return (
    <form onSubmit={onFormSubmit} className="w-72">
      <h2 className="text-white text-xl font-bold mb-4">Join the game</h2>

      {/* Nickname */}
      <input
        className="p-2 w-full border border-gray-400 text-black rounded"
        type="text"
        value={nickname}
        onChange={(e) => setNickname(e.currentTarget.value)}
        placeholder="Your nickname"
        maxLength={20}
      />

      {/* Photo upload */}
      <div className="mt-4">
        <p className="text-white text-sm mb-2">Photo of yourself *</p>

        {/* Hidden file input — opened by the button below */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="user"
          onChange={handleImageChange}
          className="hidden"
        />

        {imagePreview ? (
          <div className="flex flex-col items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imagePreview}
              alt="Your photo preview"
              className="w-28 h-28 object-cover rounded-full border-2 border-green-400"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-xs text-green-300 underline"
            >
              Change photo
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full py-8 border-2 border-dashed border-gray-500 rounded text-gray-300 text-sm hover:border-green-400 hover:text-green-300 transition-colors"
          >
            📷 Tap to take / upload photo
          </button>
        )}
      </div>

      <button
        disabled={sending}
        className="w-full py-2 bg-green-500 mt-5 text-white font-semibold rounded disabled:opacity-50"
      >
        {sending ? 'Joining…' : 'Join'}
      </button>
    </form>
  )
}
