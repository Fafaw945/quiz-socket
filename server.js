const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

// Configuration du serveur
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: [
      'https://quiz-app-eight-gold-57.vercel.app', // ton front déployé
      'http://localhost:3000', // pour tes tests locaux
    ],
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const PHP_API_URL = process.env.PHP_API_URL || 'https://quiz-api-79jx.onrender.com';
const PORT = process.env.PORT || 3001;

// ------------------------------------------
// État du Jeu Global
// ------------------------------------------
let connectedPlayers = [];
let gameStarted = false;
let currentQuestionIndex = 0;
let questions = [];
let questionTimer = null;
let currentAnswers = {};

const QUESTION_TIME_LIMIT = 15;
const REVEAL_TIME = 5000;

// ------------------------------------------
// Fonctions utilitaires
// ------------------------------------------

async function fetchPhpApi(endpoint, data = null, method = 'POST') {
  try {
    const url = `${PHP_API_URL}/api${endpoint}`;
    let response;

    if (method === 'POST') {
      response = await axios.post(url, data, {
        headers: { 'Content-Type': 'application/json' },
      });
    } else if (method === 'GET') {
      response = await axios.get(url);
    }

    return response.data;
  } catch (error) {
    console.error(`❌ Erreur lors de l'appel à ${endpoint}:`, error.response?.data || error.message);
    return { error: 'Erreur API PHP' };
  }
}

async function updatePlayersState() {
  try {
    const dbPlayers = await fetchPhpApi('/players/ready-list', null, 'GET');
    if (!Array.isArray(dbPlayers)) {
      console.error('⚠️ /api/players/ready-list a renvoyé:', dbPlayers);
      return;
    }

    const inMemoryState = new Map();
    for (const player of connectedPlayers) {
      inMemoryState.set(String(player.participantId), {
        id: player.id,
        is_ready: player.is_ready,
        has_answered_current_q: player.has_answered_current_q,
      });
    }

    const newPlayersState = dbPlayers
      .map((dbPlayer) => {
        const memoryPlayer = inMemoryState.get(String(dbPlayer.id));
        if (!memoryPlayer) return null;

        return {
          participantId: dbPlayer.id,
          pseudo: dbPlayer.pseudo,
          score: parseInt(dbPlayer.score || 0),
          is_admin: !!dbPlayer.is_admin,
          id: memoryPlayer.id,
          is_ready: memoryPlayer.is_ready,
          has_answered_current_q: memoryPlayer.has_answered_current_q,
        };
      })
      .filter((p) => p !== null);

    connectedPlayers = newPlayersState;
    io.emit('players_update', connectedPlayers);
  } catch (error) {
    console.error('Erreur updatePlayersState:', error.message);
  }
}

// ------------------------------------------
// Gestion du jeu
// ------------------------------------------
async function startQuestionRound() {
  if (currentQuestionIndex >= questions.length) {
    return endGame();
  }

  const currentQ = questions[currentQuestionIndex];
  currentAnswers = {};

  console.log(`🟢 Nouvelle question ${currentQuestionIndex + 1}: ${currentQ.question}`);

  io.emit('new_question', {
    questionNumber: currentQuestionIndex + 1,
    totalQuestions: questions.length,
    id: currentQ.id,
    questionText: currentQ.question,
    options: currentQ.answers,
    timeLimit: QUESTION_TIME_LIMIT,
  });

  if (questionTimer) clearTimeout(questionTimer);
  questionTimer = setTimeout(processQuestionEnd, QUESTION_TIME_LIMIT * 1000);

  updatePlayersState();
}

async function processQuestionEnd() {
  if (questionTimer) clearTimeout(questionTimer);

  const currentQ = questions[currentQuestionIndex];
  if (!currentQ) return;

  const questionId = currentQ.id;
  let finalCorrectAnswer = null;

  console.log(`⏰ Fin du temps. ${Object.keys(currentAnswers).length} réponses.`);

  for (const socketId in currentAnswers) {
    const answerText = currentAnswers[socketId].answer;
    const player = connectedPlayers.find((p) => p.id === socketId);

    if (player) {
      const phpResult = await fetchPhpApi('/quiz/answer', {
        player_id: player.participantId,
        question_id: questionId,
        answer: answerText,
      });

      if (phpResult?.correct_answer) {
        finalCorrectAnswer = phpResult.correct_answer;
      }

      io.to(socketId).emit('feedback_answer', {
        isCorrect: phpResult.is_correct || false,
        correctAnswer: finalCorrectAnswer || '',
      });
    }
  }

  if (!finalCorrectAnswer) {
    const phpResult = await fetchPhpApi('/quiz/answer', {
      player_id: 0,
      question_id: questionId,
      answer: '',
    });
    finalCorrectAnswer = phpResult?.correct_answer || null;
  }

  if (finalCorrectAnswer) {
    io.emit('reveal_answer', { correctAnswer: finalCorrectAnswer });
  }

  await updatePlayersState();
  currentQuestionIndex++;
  setTimeout(startQuestionRound, REVEAL_TIME);
}

async function endGame() {
  gameStarted = false;
  currentQuestionIndex = 0;
  questions = [];
  currentAnswers = {};
  if (questionTimer) clearTimeout(questionTimer);

  console.log('🏁 Fin du jeu. Envoi des scores finaux.');

  try {
    const finalScores = await fetchPhpApi('/leaderboard', null, 'GET');
    io.emit('final_scores', finalScores);
    io.emit('quiz_end');

    const admin = connectedPlayers.find((p) => p.is_admin);
    const adminId = admin ? admin.participantId : 0;

    const resetResult = await fetchPhpApi('/game/reset', { admin_id: adminId });
    console.log('Réinitialisation BDD:', resetResult);

    await updatePlayersState();
  } catch (error) {
    console.error('Erreur endGame:', error.message);
  }
}

// ------------------------------------------
// Gestion des connexions socket.io
// ------------------------------------------
io.on('connection', (socket) => {
  console.log(`✅ Connexion: ${socket.id}`);
  updatePlayersState();

  socket.on('player_info', (playerInfo) => {
    if (playerInfo && !connectedPlayers.find((p) => p.participantId === playerInfo.participantId)) {
      connectedPlayers.push({
        id: socket.id,
        participantId: playerInfo.participantId,
        pseudo: playerInfo.pseudo,
        is_admin: playerInfo.is_admin,
        score: 0,
        is_ready: false,
        has_answered_current_q: false,
      });
      console.log(`👤 Joueur ajouté: ${playerInfo.pseudo}`);
      updatePlayersState();
    }
  });

  socket.on('disconnect', () => {
    console.log(`❌ Déconnexion: ${socket.id}`);
    connectedPlayers = connectedPlayers.filter((p) => p.id !== socket.id);
    updatePlayersState();
  });

  socket.on('player_ready', async (data) => {
    const player = connectedPlayers.find((p) => p.id === socket.id);
    if (!player || !data || player.participantId !== data.participantId) {
      console.error("Erreur 'player_ready': ID incohérent.");
      return;
    }

    console.log(`⚡ ${player.pseudo} est prêt.`);
    player.is_ready = true;

    try {
      await fetchPhpApi('/players/ready', { player_id: data.participantId });
      await updatePlayersState();
    } catch (error) {
      console.error('Erreur player_ready:', error.message);
    }
  });

  socket.on('player_answer', (data) => {
    const player = connectedPlayers.find((p) => p.id === socket.id);
    if (gameStarted && player && currentQuestionIndex < questions.length && !currentAnswers[socket.id]) {
      const currentQ = questions[currentQuestionIndex];
      if (data.question_id === currentQ.id) {
        currentAnswers[socket.id] = { question_id: data.question_id, answer: data.answer };
        console.log(`💬 Réponse reçue de ${player.pseudo}`);
        updatePlayersState();
      }
    }
  });

  socket.on('start_game_request', async (data) => {
    if (gameStarted) return;

    const player = connectedPlayers.find((p) => p.id === socket.id);
    if (!player || !player.is_admin || player.participantId !== data.admin_id) {
      socket.emit('error_message', "Action réservée à l'administrateur.");
      return;
    }

    const allReady = connectedPlayers.every((p) => p.is_ready);
    if (connectedPlayers.length < 2 || !allReady) {
      socket.emit('error_message', 'Il faut au moins 2 joueurs et que tout le monde soit prêt.');
      return;
    }

    questions = await fetchPhpApi('/quiz/questions', { userId: player.participantId });
    if (!Array.isArray(questions) || questions.length === 0) {
      io.emit('error_message', "❌ Aucune question valide reçue de l'API.");
      return;
    }

    console.log(`🚀 Jeu lancé (${questions.length} questions).`);
    await fetchPhpApi('/game/reset', { admin_id: player.participantId });

    gameStarted = true;
    currentQuestionIndex = 0;
    io.emit('game_started');
    startQuestionRound();
  });
});

// ------------------------------------------
// Lancement du serveur
// ------------------------------------------
httpServer.listen(PORT, () => {
  console.log(`🔥 Serveur Socket.io sur le port ${PORT}`);
  console.log(`🎯 API PHP : ${PHP_API_URL}`);
});
