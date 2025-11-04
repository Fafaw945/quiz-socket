const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');

// Configuration du serveur
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*", // À configurer pour l'URL de votre frontend en production
        methods: ["GET", "POST"]
    }
});

// ==========================================================
// 💡 CORRECTION 1 : Retrait de la barre oblique (/) finale
// ==========================================================
const PHP_API_URL = process.env.PHP_API_URL || 'https://quiz-api-79jx.onrender.com'; 
const PORT = process.env.PORT || 3001;

// ------------------------------------------
// État du Jeu Global
// ------------------------------------------
let connectedPlayers = []; // Stocke les joueurs actuellement connectés par socket.id
let gameStarted = false;
let currentQuestionIndex = 0;
let questions = []; // Cache des 10 questions récupérées de l'API
let questionTimer = null; 

let currentAnswers = {}; 

const QUESTION_TIME_LIMIT = 15; // 15 secondes par question
const REVEAL_TIME = 5000; // 5 secondes pour la révélation de la réponse

// Fonction utilitaire pour appeler l'API PHP (POST par défaut)
async function fetchPhpApi(endpoint, data = null, method = 'POST') {
    try {
        // L'URL est maintenant correcte (ex: ...onrender.com/api/...)
        const url = `${PHP_API_URL}/api${endpoint}`; 
        let response;

        if (method === 'POST') {
            response = await axios.post(url, data);
        } else if (method === 'GET') {
             response = await axios.get(url);
        }
        
        return response.data;
    } catch (error) {
        console.error(`Erreur lors de l'appel à l'API PHP ${endpoint}:`, error.response ? error.response.data : error.message);
        return { error: 'Erreur d\'API' };
    }
}

// ==========================================================
// 💡 CORRECTION 2 : Fonction updatePlayersState remplacée
// (Fusionne l'état BDD et l'état Mémoire)
// ==========================================================
async function updatePlayersState() {
    try {
        const dbPlayers = await fetchPhpApi('/players/ready-list', null, 'GET'); 

        if (!Array.isArray(dbPlayers)) {
             console.error("Erreur: /api/players/ready-list n'a pas retourné un tableau. Réponse:", dbPlayers);
             return; 
        }

        // Créer une map de l'état en mémoire (la source de vérité pour 'is_ready')
        const inMemoryState = new Map();
        for (const player of connectedPlayers) {
            inMemoryState.set(player.participantId, {
                id: player.id, // ID Socket
                is_ready: player.is_ready, // <-- L'état 'ready' de la session en cours
                has_answered_current_q: player.has_answered_current_q
            });
        }

        const newPlayersState = dbPlayers.map(dbPlayer => {
            // Récupérer l'état en mémoire pour ce joueur (par son ID de BDD)
            const memoryPlayer = inMemoryState.get(dbPlayer.id); // On compare l'ID BDD
            
            if (!memoryPlayer) return null; // Joueur déconnecté

            return {
                // Données de la BDD (persistantes)
                participantId: dbPlayer.id,
                pseudo: dbPlayer.pseudo,
                score: parseInt(dbPlayer.score || 0),
                is_admin: !!dbPlayer.is_admin,
                
                // Données de la Mémoire (session actuelle)
                id: memoryPlayer.id, // ID Socket
                is_ready: memoryPlayer.is_ready, // <-- Utiliser l'état 'ready' de la mémoire
                has_answered_current_q: memoryPlayer.has_answered_current_q,
            };
        }).filter(p => p !== null); 

        connectedPlayers = newPlayersState;
        io.emit('players_update', connectedPlayers);
    } catch (error) {
        console.error("Erreur lors de la mise à jour des joueurs:", error.message);
    }
}


// Démarrer la routine de la question
async function startQuestionRound() {
    if (currentQuestionIndex >= questions.length) {
        return endGame();
    }

    const currentQ = questions[currentQuestionIndex];
    
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

    updatePlayersState();
}

/**
 * Fonction appelée lorsque le minuteur de la question expire.
 */
async function processQuestionEnd() {
    if (questionTimer) clearTimeout(questionTimer);
    
    const currentQ = questions[currentQuestionIndex];
    if (!currentQ) return;
    
    const questionId = currentQ.id;
    let finalCorrectAnswer = null;

    console.log(`Minuteur terminé. Traitement des ${Object.keys(currentAnswers).length} réponses soumises.`);

    // --- 1. Vérification et Scoring ---
    for (const socketId in currentAnswers) {
        const answerText = currentAnswers[socketId].answer;
        const player = connectedPlayers.find(p => p.id === socketId);
        
        if (player) {
            const phpResult = await fetchPhpApi('/quiz/answer', {
                player_id: player.participantId, 
                question_id: questionId,
                answer: answerText
            });

            if (phpResult && phpResult.correct_answer) {
                finalCorrectAnswer = phpResult.correct_answer;
            }

            io.to(socketId).emit('feedback_answer', {
                isCorrect: phpResult.is_correct || false,
                correctAnswer: finalCorrectAnswer || '' 
            });
        }
    }
    
    // --- 2. Récupération de la réponse correcte finale (si non définie) ---
    if (!finalCorrectAnswer) {
        const phpResult = await fetchPhpApi('/quiz/answer', { 
            player_id: 0, 
            question_id: questionId,
            answer: "" 
        });
        if (phpResult && phpResult.correct_answer) {
            finalCorrectAnswer = phpResult.correct_answer;
        }
    }

    // --- 3. Révélation de la Réponse à tous ---
    if (finalCorrectAnswer) {
        io.emit('reveal_answer', { correctAnswer: finalCorrectAnswer });
    }

    // --- 4. Préparation pour la prochaine question ---
    await updatePlayersState(); 

    currentQuestionIndex++;
    
    setTimeout(startQuestionRound, REVEAL_TIME); 
}


// Logique de fin de jeu
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
        console.log("État du jeu BDD réinitialisé:", resetResult);
        
        await updatePlayersState();

    } catch (error) {
        console.error("Erreur lors de la fin du jeu ou de la réinitialisation:", error.message);
    }
}


// ------------------------------------------
// Gestion des Sockets (Connexions/Événements)
// ------------------------------------------
io.on('connection', (socket) => {
    console.log(`Utilisateur connecté: ${socket.id}`);

    updatePlayersState(); 

    socket.on('player_info', (playerInfo) => {
        // ==========================================================
        // 💡 CORRECTION 3 : Vérifier si le participantId est déjà connecté
        // ==========================================================
        if (playerInfo && !connectedPlayers.find(p => p.participantId === playerInfo.participantId)) {
            connectedPlayers.push({
                id: socket.id,
                participantId: playerInfo.participantId,
                pseudo: playerInfo.pseudo,
                is_admin: playerInfo.is_admin,
                score: 0,
                is_ready: false, // Toujours 'false' à la connexion
                has_answered_current_q: false,
            });
            console.log("Joueur ajouté:", playerInfo.pseudo);
            updatePlayersState();
        }
    });
    
    socket.on('disconnect', () => {
        console.log(`Utilisateur déconnecté: ${socket.id}`);
        connectedPlayers = connectedPlayers.filter(p => p.id !== socket.id);
        updatePlayersState(); 
    });
    
    // ==========================================================
    // 💡 CORRECTION 4 : Logique 'player_ready'
    // ==========================================================
    socket.on('player_ready', async (data) => {
        const player = connectedPlayers.find(p => p.id === socket.id);
        
        if (!player || !data || player.participantId !== data.participantId) {
             console.error("Erreur 'player_ready' : ID non concordant ou joueur non trouvé.");
             return;
        }

        console.log(`Joueur ${player.pseudo} (ID: ${data.participantId}) est prêt.`);

        try {
            // 1. Mettre à jour l'état en mémoire D'ABORD
            player.is_ready = true;

            // 2. Appeler l'API PHP pour mettre à jour la BDD
            await fetchPhpApi('/players/ready', { 
                player_id: data.participantId 
            });

            // 3. Mettre à jour l'état de tous les joueurs (il lira 'true' depuis la mémoire)
            await updatePlayersState();

        } catch (error) {
            console.error("Erreur lors de la mise à jour de l'état 'prêt':", error.message);
        }
    });
    // ===========================================
    

    socket.on('player_answer', (data) => {
        const player = connectedPlayers.find(p => p.id === socket.id);
        
        if (gameStarted && player && currentQuestionIndex < questions.length && !currentAnswers[socket.id]) {
            const currentQ = questions[currentQuestionIndex];
            
            if (data.question_id === currentQ.id) {
                currentAnswers[socket.id] = {
                    question_id: data.question_id,
                    answer: data.answer
                };
                
                console.log(`Réponse stockée pour ${player.pseudo}.`);
                
                updatePlayersState(); 
            }
        }
    });
    
    socket.on('start_game_request', async (data) => {
        if (gameStarted) return; 
        
        const player = connectedPlayers.find(p => p.id === socket.id);
        if (!player || !player.is_admin || player.participantId !== data.admin_id) {
            socket.emit('error_message', 'Action réservée à l’administrateur.');
            return;
        }

        // Vérification si tout le monde est prêt (ajoutée ici pour plus de sécurité)
        const allReady = connectedPlayers.every(p => p.is_ready);
        if (connectedPlayers.length < 2 || !allReady) {
            socket.emit('error_message', 'Il faut au moins 2 joueurs et que tout le monde soit prêt.');
            return;
        }

        // Récupérer les questions aléatoires
        questions = await fetchPhpApi('/quiz/questions', { userId: player.participantId });
        
        if (!questions || !Array.isArray(questions) || questions.length === 0) {
            console.error("Erreur: Pas de questions valides reçues de l'API.");
            io.emit('error_message', '❌ Aucune question valide reçue de l\'API. L\'API est peut-être inaccessible.');
            return;
        }

        console.log(`Début du jeu avec ${questions.length} questions.`);

        const resetResult = await fetchPhpApi('/game/reset', { admin_id: player.participantId });
        console.log("Réinitialisation avant jeu:", resetResult);
        
        gameStarted = true;
        currentQuestionIndex = 0;
        
        io.emit('game_started'); // <-- C'est cet événement
        startQuestionRound(); 
    });
});


httpServer.listen(PORT, () => {
    console.log(`Serveur Node.js Socket.io en cours d'exécution sur le port ${PORT}`);
    console.log(`API PHP ciblée à: ${PHP_API_URL}`);
});