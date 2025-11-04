// server.js (version corrigée)
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*", // change en production pour l'URL frontend
    methods: ["GET", "POST"]
  }
});

const PHP_API_URL = process.env.PHP_API_URL || 'https://quiz-api-79jx.onrender.com';
const PORT = process.env.PORT || 3001;

// État du jeu global
let connectedPlayers = []; // { id: socketId, participantId, pseudo, is_admin, score, is_ready, has_answered_current_q }
let gameStarted = false;
let currentQuestionIndex = 0;
let questions = [];
let questionTimer = null;
let currentAnswers = {};

const QUESTION_TIME_LIMIT = 15;
const REVEAL_TIME = 5000;

async function fetchPhpApi(endpoint, data = null, method = 'POST') {
  try {
    const url = `${PHP_API_URL}/api${endpoint}`;
    let response;
    if (method === 'POST') response = await axios.post(url, data);
    else if (method === 'GET') response = await axios.get(url);
    return response.data;
  } catch (error) {
    console.error(`Erreur API ${endpoint}:`, error.response ? error.response.data : error.message);
    return { error: 'Erreur d\'API' };
  }
}

/**
 * Synchronise l'état en mémoire (connectedPlayers) avec la BDD (/players/ready-list).
 * Important : on reconstruit connectedPlayers en se basant sur la liste renvoyée par l'API
 * mais on conserve l'id socket et l'état en mémoire (is_ready...) si le joueur est connecté.
 */
async function updatePlayersState() {
  try {
    const dbPlayers = await fetchPhpApi('/players/ready-list', null, 'GET');

    if (!Array.isArray(dbPlayers)) {
      console.error("Erreur: /api/players/ready-list n'a pas retourné un tableau:", dbPlayers);
      return;
    }

    // Créer une map depuis l'état mémoire pour retrouver rapidement par participantId
    const inMemoryState = new Map();
    for (const player of connectedPlayers) {
      inMemoryState.set(String(player.participantId), {
        id: player.id,
        is_ready: !!player.is_ready,
        has_answered_current_q: !!player.has_answered_current_q,
        pseudo: player.pseudo,
        score: player.score || 0,
        is_admin: !!player.is_admin
      });
    }

    // Construire l'état combiné à envoyer au front
    const newPlayersState = dbPlayers.map(dbPlayer => {
      const memoryPlayer = inMemoryState.get(String(dbPlayer.id));
      if (!memoryPlayer) {
        // Joueur présent en BDD mais pas connecté => on ignore (ou on peut renvoyer avec id null)
        return null;
      }
      return {
        participantId: dbPlayer.id,
        pseudo: dbPlayer.pseudo || memoryPlayer.pseudo || `Player${dbPlayer.id}`,
        score: parseInt(dbPlayer.score || memoryPlayer.score || 0),
        is_admin: !!dbPlayer.is_admin || memoryPlayer.is_admin,
        id: memoryPlayer.id,
        is_ready: memoryPlayer.is_ready,
        has_answered_current_q: memoryPlayer.has_answered_current_q
      };
    }).filter(p => p !== null);

    connectedPlayers = newPlayersState;
    io.emit('players_update', connectedPlayers);
  } catch (error) {
    console.error("Erreur updatePlayersState:", error.message || error);
  }
}

async function startQuestionRound() {
  if (currentQuestionIndex >= questions.length) {
    return endGame();
  }

  const currentQ = questions[currentQuestionIndex];
  if (!currentQ) return endGame();

  currentAnswers = {};
  console.log(`Démarrage question ${currentQuestionIndex + 1}: ${currentQ.question}`);

  io.emit('new_question', {
    questionNumber: currentQuestionIndex + 1,
    totalQuestions: questions.length,
    id: currentQ.id,
    questionText: currentQ.question,
    options: currentQ.answers,
    timeLimit: QUESTION_TIME_LIMIT
  });

  if (questionTimer) clearTimeout(questionTimer);
  questionTimer = setTimeout(processQuestionEnd, QUESTION_TIME_LIMIT * 1000);

  await updatePlayersState();
}

async function processQuestionEnd() {
  if (questionTimer) clearTimeout(questionTimer);
  const currentQ = questions[currentQuestionIndex];
  if (!currentQ) return;

  const questionId = currentQ.id;
  let finalCorrectAnswer = null;

  console.log(`Minuteur terminé. Réponses reçues: ${Object.keys(currentAnswers).length}`);

  // Traiter chaque réponse envoyée
  for (const socketId in currentAnswers) {
    const answerText = currentAnswers[socketId].answer;
    const player = connectedPlayers.find(p => p.id === socketId);
    if (!player) continue;

    const phpResult = await fetchPhpApi('/quiz/answer', {
      player_id: player.participantId,
      question_id: questionId,
      answer: answerText
    });

    if (phpResult && phpResult.correct_answer) finalCorrectAnswer = phpResult.correct_answer;

    io.to(socketId).emit('feedback_answer', {
      isCorrect: phpResult.is_correct || false,
      correctAnswer: finalCorrectAnswer || ''
    });
  }

  // Si on n'a toujours pas la bonne réponse, demander à l'API sans joueur pour récupérer correct_answer
  if (!finalCorrectAnswer) {
    const phpResult = await fetchPhpApi('/quiz/answer', {
      player_id: 0,
      question_id: questionId,
      answer: ""
    });
    if (phpResult && phpResult.correct_answer) finalCorrectAnswer = phpResult.correct_answer;
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

  console.log("Jeu terminé. Envoi des scores finaux.");

  try {
    const finalScores = await fetchPhpApi('/leaderboard', null, 'GET');
    io.emit('final_scores', finalScores);
    io.emit('quiz_end');

    const admin = connectedPlayers.find(p => p.is_admin);
    const adminId = admin ? admin.participantId : 0;

    const resetResult = await fetchPhpApi('/game/reset', { admin_id: adminId });
    console.log("Réinitialisation BDD:", resetResult);

    await updatePlayersState();
  } catch (error) {
    console.error("Erreur endGame:", error.message || error);
  }
}

// Gestion des sockets
io.on('connection', (socket) => {
  console.log(`Utilisateur connecté: ${socket.id}`);

  // Lors d'une connexion on renvoie l'état actuel (utile si quelqu'un reload)
  socket.emit('connected', { socketId: socket.id });
  updatePlayersState();

  socket.on('player_info', (playerInfo) => {
    try {
      // Vérifie qu'on n'a pas déjà ce participant connecté (même participantId)
      const already = connectedPlayers.find(p => p.participantId === playerInfo.participantId);
      if (!already) {
        connectedPlayers.push({
          id: socket.id,
          participantId: playerInfo.participantId,
          pseudo: playerInfo.pseudo,
          is_admin: playerInfo.is_admin,
          score: 0,
          is_ready: false,
          has_answered_current_q: false
        });
        console.log("Joueur ajouté:", playerInfo.pseudo);
        updatePlayersState();
      } else {
        // Si participant déjà en mémoire, on met simplement à jour son socket id
        already.id = socket.id;
        already.pseudo = playerInfo.pseudo;
        already.is_admin = playerInfo.is_admin;
        console.log("Joueur re-connecté, mise à jour socketId:", playerInfo.pseudo);
        updatePlayersState();
      }
    } catch (err) {
      console.error("Erreur player_info:", err);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Utilisateur déconnecté: ${socket.id}`);
    connectedPlayers = connectedPlayers.filter(p => p.id !== socket.id);
    updatePlayersState();
  });

  socket.on('player_ready', async (data) => {
    const player = connectedPlayers.find(p => p.id === socket.id);
    if (!player || !data || player.participantId !== data.participantId) {
      console.error("Erreur 'player_ready' : joueur non trouvé ou ID non concordant.");
      socket.emit('error_message', 'Impossible de passer en prêt (incohérence ID).');
      return;
    }

    console.log(`Player ${player.pseudo} ready request`);

    try {
      // 1) Mettre à jour la mémoire
      player.is_ready = true;

      // 2) Appel API pour marquer prêt
      await fetchPhpApi('/players/ready', { player_id: data.participantId });

      // 3) Broadcast nouvel état
      await updatePlayersState();
    } catch (error) {
      console.error("Erreur player_ready:", error.message || error);
      socket.emit('error_message', 'Erreur lors de la mise à jour du statut prêt.');
    }
  });

  socket.on('player_unready', async (data) => {
    const player = connectedPlayers.find(p => p.id === socket.id);
    if (!player || !data || player.participantId !== data.participantId) {
      socket.emit('error_message', 'Impossible d\'annuler le prêt (incohérence ID).');
      return;
    }

    try {
      player.is_ready = false;
      await fetchPhpApi('/players/unready', { player_id: data.participantId });
      await updatePlayersState();
    } catch (error) {
      console.error("Erreur player_unready:", error);
    }
  });

  socket.on('player_answer', (data) => {
    const player = connectedPlayers.find(p => p.id === socket.id);
    if (gameStarted && player && currentQuestionIndex < questions.length && !currentAnswers[socket.id]) {
      const currentQ = questions[currentQuestionIndex];
      if (data.question_id === currentQ.id) {
        currentAnswers[socket.id] = {
          question_id: data.question_id,
          answer: data.answer
        };
        player.has_answered_current_q = true;
        console.log(`Réponse reçue de ${player.pseudo}`);
        updatePlayersState();
      }
    }
  });

  socket.on('start_game_request', async (data) => {
    if (gameStarted) {
      socket.emit('error_message', 'Le jeu a déjà commencé.');
      return;
    }

    const player = connectedPlayers.find(p => p.id === socket.id);
    if (!player || !player.is_admin || player.participantId !== data.admin_id) {
      socket.emit('error_message', 'Action réservée à l’administrateur.');
      return;
    }

    // Tout le monde doit être prêt et au moins 2 joueurs
    const allReady = connectedPlayers.length > 0 && connectedPlayers.every(p => p.is_ready);
    if (connectedPlayers.length < 2 || !allReady) {
      socket.emit('error_message', 'Il faut au moins 2 joueurs et que tout le monde soit prêt.');
      return;
    }

    // Récupère les questions depuis l'API
    const fetched = await fetchPhpApi('/quiz/questions', { userId: player.participantId });
    if (!fetched || !Array.isArray(fetched) || fetched.length === 0) {
      console.error("Aucune question valide reçue.");
      io.to(socket.id).emit('error_message', 'Aucune question valide reçue de l\'API.');
      return;
    }

    questions = fetched;
    console.log(`Début du jeu avec ${questions.length} questions.`);

    try {
      await fetchPhpApi('/game/reset', { admin_id: player.participantId });
    } catch (err) {
      console.warn("Warning reset avant jeu:", err.message || err);
    }

    gameStarted = true;
    currentQuestionIndex = 0;

    // Événement cohérent envoyé au front (même nom que le client doit écouter)
    io.emit('game_started');
    startQuestionRound();
  });
});

httpServer.listen(PORT, () => {
  console.log(`Socket.io server running on port ${PORT}`);
  console.log(`PHP API: ${PHP_API_URL}`);
});
