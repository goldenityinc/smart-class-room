require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { OpenAI } = require('openai');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

const SUPPORTED_LANGUAGES = {
  english: { label: 'English', code: 'en' },
  indonesian: { label: 'Indonesian', code: 'id' },
  japanese: { label: 'Japanese', code: 'ja' },
  spanish: { label: 'Spanish', code: 'es' },
};

const FORBIDDEN_TRANSCRIPT_PHRASES = new Set([
  'thanks for watching.',
  'thank you for watching.',
  'thanks for watching!',
  'thank you.',
  'terima kasih.',
  'thanks for watching',
  'thank you for watching',
  'thank you',
  'terima kasih',
]);

const clientPreferences = new Map();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.static(path.join(__dirname, 'public')));

function normalizeLanguage(languageKey) {
  if (!languageKey) {
    return SUPPORTED_LANGUAGES.english;
  }

  return SUPPORTED_LANGUAGES[String(languageKey).toLowerCase()] ?? SUPPORTED_LANGUAGES.english;
}

function shouldUseRecipientPreference(targetLanguage) {
  const normalizedTarget = String(targetLanguage || '').toLowerCase();

  return !normalizedTarget || normalizedTarget === 'auto' || normalizedTarget === 'per-recipient';
}

function normalizeTranscriptText(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function shouldIgnoreTranscript(text) {
  const normalizedText = normalizeTranscriptText(text);

  return !normalizedText || FORBIDDEN_TRANSCRIPT_PHRASES.has(normalizedText);
}

async function transcribeAudio(tempFilePath, sourceLanguage) {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(tempFilePath),
    model: 'whisper-1',
    language: sourceLanguage.code,
  });

  return transcription.text?.trim() ?? '';
}

async function translateText(rawText, sourceLanguage, targetLanguage) {
  if (sourceLanguage.code === targetLanguage.code) {
    return rawText;
  }

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'Translate this text to the requested target language.',
      },
      {
        role: 'user',
        content: `Source language: ${sourceLanguage.label}\nTarget language: ${targetLanguage.label}\nText: ${rawText}\n\nReturn only the translated text.`,
      },
    ],
  });

  return completion.choices[0]?.message?.content?.trim() ?? rawText;
}

async function synthesizeSpeech(text) {
  const mp3 = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'alloy',
    input: text,
  });

  return Buffer.from(await mp3.arrayBuffer());
}

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  clientPreferences.set(socket.id, { language: SUPPORTED_LANGUAGES.english });

  socket.emit('sessionReady', {
    socketId: socket.id,
    language: SUPPORTED_LANGUAGES.english,
  });

  socket.on('setLanguage', (languageKey) => {
    const language = normalizeLanguage(languageKey);
    clientPreferences.set(socket.id, { language });

    socket.emit('languageUpdated', language);
  });

  socket.on('chatAudio', async ({ audioBuffer, sourceLanguage, targetLanguage }) => {
    const audioSize = audioBuffer?.byteLength ?? audioBuffer?.length ?? 0;
    const normalizedSourceLanguage = normalizeLanguage(sourceLanguage);

    console.log('\n--- MENERIMA AUDIO CHAT ---');
    console.log('Client:', socket.id);
    console.log('Source language:', normalizedSourceLanguage.label);
    console.log('Requested target:', targetLanguage || 'per-recipient');
    console.log('Ukuran data:', audioSize, 'bytes');

    const tempFilePath = path.join(__dirname, `temp_${socket.id}.webm`);

    try {
      fs.writeFileSync(tempFilePath, Buffer.from(audioBuffer));

      const originalText = await transcribeAudio(tempFilePath, normalizedSourceLanguage);

      console.log('Original:', originalText);

      if (shouldIgnoreTranscript(originalText)) {
        console.log('Audio kosong/halusinasi diabaikan.');
        return;
      }

      const recipients = Array.from(io.sockets.sockets.keys());

      await Promise.all(
        recipients.map(async (recipientId) => {
          const preferredLanguage = shouldUseRecipientPreference(targetLanguage)
            ? clientPreferences.get(recipientId)?.language ?? SUPPORTED_LANGUAGES.english
            : normalizeLanguage(targetLanguage);

          const translatedText = await translateText(
            originalText,
            normalizedSourceLanguage,
            preferredLanguage
          );
          const speechBuffer = await synthesizeSpeech(translatedText);

          io.to(recipientId).emit('chatReceive', {
            senderId: socket.id,
            originalText,
            translatedText,
            sourceLanguage: normalizedSourceLanguage.label,
            targetLanguage: preferredLanguage.label,
            audioData: speechBuffer,
          });
        })
      );
    } catch (error) {
      console.error('Error:', error.message);

      socket.emit('chatReceive', {
        senderId: socket.id,
        originalText: '',
        translatedText: '[Error processing audio]',
        sourceLanguage: normalizedSourceLanguage.label,
        targetLanguage: normalizedSourceLanguage.label,
        audioData: null,
      });
    } finally {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }
  });

  socket.on('disconnect', () => {
    clientPreferences.delete(socket.id);
    console.log(`Client disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Smart Classroom server running at http://localhost:${PORT}`);
});