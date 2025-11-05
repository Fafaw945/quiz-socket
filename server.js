const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PHP_API_URL = process.env.PHP_API_URL || 'https://quiz-api-79jx.onrender.com'; 
const PORT = process.env.PORT || 3001;

let connectedPlayers = []; 
let gameStarted = false;
let currentQuestionIndex = 0;
let questions = []; 
let questionTimer = null; 
let currentAnswers = {}; 

const QUESTION_TIME_LIMIT = 10; 
const REVEAL_TIME = 4000; 

async function fetchPhpApi(endpoint, data = null, method = 'POST') {
    try {
        const url = `${PHP_API_URL}/api${endpoint}`; 
        let response;
        if (method === 'POST') {
            response = await axios.post(url, data);
        } else if (method === 'GET') {
             response = await axios.get(url);
        }
        return response.data;
    } catch (error) {
        console.error(`Erreur API PHP ${endpoint}:`, error.message);
        return { error: 'Erreur d\'API' };
    }
}

async function updatePlayersState() {
    try {
        const dbPlayers = await fetchPhpApi('/players/ready-list', null, 'GET'); 
        if (!Array.isArray(dbPlayers)) return;

        const inMemoryState = new Map();
        for (const player of connectedPlayers) {
            inMemoryState.set(String(player.participantId), {
                id: player.id, 
                is_ready: player.is_ready,
                has_answered_current_q: player.has_answered_current_q
            });
        }

        const newPlayersState = dbPlayers.map(dbPlayer => {
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
        }).filter(p => p !== null); 

        connectedPlayers = newPlayersState;
        io.emit('players_update', connectedPlayers);
    } catch (error) {
        console.error("Erreur updatePlayersState:", error.message);
    }
}

async function startQuestionRound() {
    // Sécurité : si on dépasse le nombre de questions, on finit.
    if (currentQuestionIndex >= questions.length) {
        return endGame();
    }

    const currentQ = questions[currentQuestionIndex];
    currentAnswers = {}; 

    console.log(`--- QUESTION ${currentQuestionIndex + 1} / ${questions.length} ---`);
    console.log(`Envoi: "${currentQ.question}"`);
    
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

    // Réinitialiser le statut "a répondu" pour tous les joueurs
    connectedPlayers.forEach(p => p.has_answered_current_q = false);
    updatePlayersState();
}

async function processQuestionEnd() {
    if (questionTimer) clearTimeout(questionTimer);
    
    const currentQ = questions[currentQuestionIndex];
    if (!currentQ) return;
    
    console.log(`Fin du temps. Traitement des ${Object.keys(currentAnswers).length} réponses.`);

    let finalCorrectAnswer = null;

    // Traitement des réponses
    for (const socketId in currentAnswers) {
        const answerData = currentAnswers[socketId];
        // On utilise l'ID envoyé par le client s'il existe, sinon celui en mémoire
        const participantId = answerData.participantId; 
        
        if (participantId) {
            const phpResult = await fetchPhpApi('/quiz/answer', {
                player_id: participantId, 
                question_id: currentQ.id,
                answer: answerData.answer
            });

            if (phpResult && phpResult.correct_answer) {
                finalCorrectAnswer = phpResult.correct_answer;
            }
            
            // Feedback individuel
            io.to(socketId).emit('feedback_answer', {
                isCorrect: phpResult.is_correct || false,
                correctAnswer: finalCorrectAnswer || '' 
            });
        }
    }
    
    // Si personne n'a répondu, on doit quand même chercher la bonne réponse
    if (!finalCorrectAnswer) {
        const phpResult = await fetchPhpApi('/quiz/answer', { 
            player_id: 0, 
            question_id: currentQ.id,
            answer: "" 
        });
        if (phpResult && phpResult.correct_answer) {
            finalCorrectAnswer = phpResult.correct_answer;
        }
    }

    console.log(`Révélation de la réponse : ${finalCorrectAnswer}`);
    io.emit('reveal_answer', { correctAnswer: finalCorrectAnswer });
    // Préparation question suivante
    await updatePlayersState(); 
    currentQuestionIndex++; // Incrémentation ICI SEULEMENT
    setTimeout(startQuestionRound, REVEAL_TIME); 
}

async function endGame() {
    gameStarted = false;
    currentQuestionIndex = 0;
    if (questionTimer) clearTimeout(questionTimer);

    console.log("FIN DU JEU. Envoi des scores.");

    try {
        const finalScores = await fetchPhpApi('/leaderboard', null, 'GET');
        io.emit('final_scores', finalScores);
        io.emit('quiz_end');
        
        // Reset BDD
        const admin = connectedPlayers.find(p => p.is_admin);
        const adminId = admin ? admin.participantId : 0; 
        await fetchPhpApi('/game/reset', { admin_id: adminId }); 
        
        // Reset états locaux
        connectedPlayers.forEach(p => { p.is_ready = false; p.has_answered_current_q = false; });
        await updatePlayersState();
    } catch (error) {
        console.error("Erreur endGame:", error.message);
    }
}io.on('connection', (socket) => {
    console.log(`+ Connecté: ${socket.id}`);
    updatePlayersState(); 

    socket.on('player_info', (playerInfo) => {
        if (playerInfo && !connectedPlayers.find(p => p.participantId === playerInfo.participantId)) {
            connectedPlayers.push({
                id: socket.id,
                participantId: playerInfo.participantId, 
                pseudo: playerInfo.pseudo,
                is_admin: playerInfo.is_admin,
                score: 0, 
                is_ready: false, 
                has_answered_current_q: false,
            });
            console.log(`Joueur identifié: ${playerInfo.pseudo} (ID: ${playerInfo.participantId})`);
            updatePlayersState();
        }
    });
    
    socket.on('disconnect', () => {
        console.log(`- Déconnecté: ${socket.id}`);
        connectedPlayers = connectedPlayers.filter(p => p.id !== socket.id);
        updatePlayersState(); 
    });
    
    socket.on('player_ready', async (data) => {
        const player = connectedPlayers.find(p => p.id === socket.id);
        if (player && data.participantId) {
            player.is_ready = true; // Optimistic UI update
            await fetchPhpApi('/players/ready', { player_id: data.participantId });
            updatePlayersState();
        }
    });
    
    socket.on('player_answer', (data) => {
        // 💡 CORRECTION : Logs détaillés pour déboguer le score
        const player = connectedPlayers.find(p => p.id === socket.id);
        if (!gameStarted) return;

        console.log(`Réponse reçue de ${player ? player.pseudo : 'Inconnu'} : ${data.answer}`);

        if (currentAnswers[socket.id]) {
             console.log("-> A déjà répondu ! Ignoré.");
             return;
        }

        // On stocke la réponse avec l'ID du participant envoyé par le client
        currentAnswers[socket.id] = {
            question_id: data.question_id,
            answer: data.answer,
            participantId: data.participantId || (player ? player.participantId : null)
        };
        
        updatePlayersState(); 
    });
    
    socket.on('start_game_request', async (data) => {
        if (gameStarted) {
            console.log("Tentative de lancement alors que le jeu est déjà en cours. Ignoré.");
            return; 
        }
        
        const player = connectedPlayers.find(p => p.id === socket.id);
        if (!player || !player.is_admin) return;

        console.log("=== DÉMARRAGE DU QUIZ DEMANDÉ ===");

        // 1. Verrouiller immédiatement pour éviter double lancement
        gameStarted = true; 
        currentQuestionIndex = 0; // 💡 CORRECTION : Forcer à 0 ici

        questions = await fetchPhpApi('/quiz/questions', { userId: player.participantId });
        
        if (!questions || !Array.isArray(questions) || questions.length === 0) {
            console.error("ERREUR: Aucune question reçue ! Annulation.");
            gameStarted = false; // Déverrouiller en cas d'erreur
            io.emit('error_message', 'Erreur: Impossible de récupérer les questions.');
            return;
        }

        await fetchPhpApi('/game/reset', { admin_id: player.participantId });
        
        io.emit('game_started'); 
        // Petit délai pour laisser les clients naviguer vers /quiz
        setTimeout(startQuestionRound, 1000); 
    });
});

httpServer.listen(PORT, () => {
    console.log(`Serveur Socket.io prêt sur le port ${PORT}`);
});