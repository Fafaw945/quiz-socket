const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');
const { performance } = require('perf_hooks'); // Nécessaire pour les minuteurs précis

// Configuration du serveur
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*", // Permettre toutes les origines pour le développement
        methods: ["GET", "POST"]
    }
});

const PORT = 3001;
const PHP_API_URL = 'http://localhost:8000/api'; // Assurez-vous que l'URL est correcte

// ------------------------------------------
// État du Jeu Global
// ------------------------------------------
let connectedPlayers = [];
let gameStarted = false;
let currentQuestionIndex = 0;
let questions = [];
let questionTimer = null; // Référence au minuteur Node.js (pour le délai)

// Suivi des réponses soumises pendant le temps imparti
let currentAnswers = {}; // { socketId: { question_id: string, answer: string } }
let correctAnswerData = {}; // { question_id: string, correctAnswer: string }

const QUESTION_TIME_LIMIT = 15; // 15 secondes par question

// Fonction utilitaire pour appeler l'API PHP
async function fetchPhpApi(endpoint, data = {}) {
    try {
        const response = await axios.post(`${PHP_API_URL}${endpoint}`, data);
        return response.data;
    } catch (error) {
        console.error(`Erreur lors de l'appel à l'API PHP ${endpoint}:`, error.response ? error.response.data : error.message);
        return { error: 'Erreur d\'API' };
    }
}

// Mettre à jour et émettre l'état des joueurs
async function updatePlayersState() {
    try {
        const response = await axios.get(`${PHP_API_URL}/players/ready-list`);
        const dbPlayers = response.data;

        // Assurez-vous que les joueurs connectés sont mis à jour avec les infos BDD
        const newPlayersState = dbPlayers.map(dbPlayer => {
            // Trouver l'état de connexion Socket.io
            const connectedPlayer = connectedPlayers.find(p => p.pseudo === dbPlayer.pseudo);
            
            if (!connectedPlayer) return null; // Ignorer les joueurs de la BDD qui ne sont pas connectés via socket

            return {
                id: connectedPlayer.id, 
                participantId: connectedPlayer.participantId, // L'ID BDD original du joueur
                pseudo: dbPlayer.pseudo,
                score: parseInt(dbPlayer.score || 0),
                is_admin: dbPlayer.is_admin,
                is_ready: dbPlayer.is_ready,
                // Vérifier si le joueur a soumis une réponse pour la question actuelle
                has_answered_current_q: !!currentAnswers[connectedPlayer.id],
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
        // Fin du jeu
        return endGame();
    }

    const currentQ = questions[currentQuestionIndex];
    
    // Réinitialiser l'état des réponses et du score correct
    currentAnswers = {}; 
    correctAnswerData = {};

    console.log(`Démarrage question ${currentQuestionIndex + 1}: ${currentQ.question}`);
    
    // Émission de la nouvelle question
    io.emit('new_question', {
        questionNumber: currentQuestionIndex + 1,
        totalQuestions: questions.length,
        id: currentQ.id,
        questionText: currentQ.question,
        options: currentQ.answers, // Utilise la clé 'answers' reçue du PHP
        timeLimit: QUESTION_TIME_LIMIT
    });
    
    // Lancer le minuteur qui DÉCLENCHERA LE SCORING (l'événement crucial)
    if (questionTimer) clearTimeout(questionTimer);
    questionTimer = setTimeout(processQuestionEnd, QUESTION_TIME_LIMIT * 1000);

    // Mettre à jour l'état des joueurs (pour réinitialiser l'indicateur "answered")
    updatePlayersState();
}

/**
 * Fonction appelée lorsque le minuteur de la question expire.
 * C'est ici que nous vérifions les réponses et mettons à jour les scores.
 */
async function processQuestionEnd() {
    // Annuler le minuteur pour éviter les doubles exécutions
    if (questionTimer) clearTimeout(questionTimer);
    
    const currentQ = questions[currentQuestionIndex];
    if (!currentQ) return;
    
    const questionId = currentQ.id;
    let finalCorrectAnswer = null;

    console.log(`Minuteur terminé. Traitement des ${Object.keys(currentAnswers).length} réponses soumises.`);

    // --- 1. Vérification et Scoring (Score Incrémenté MAINTENANT) ---
    for (const socketId in currentAnswers) {
        const answerText = currentAnswers[socketId].answer;
        const player = connectedPlayers.find(p => p.id === socketId);
        
        if (player) {
            // APPEL PHP POUR SCORING : Le score BDD est mis à jour ici, APRÈS le délai
            const phpResult = await fetchPhpApi('/quiz/answer', {
                player_id: player.participantId, 
                question_id: questionId,
                answer: answerText
            });

            // Stocker la réponse correcte pour l'étape de révélation
            if (phpResult && phpResult.correct_answer) {
                finalCorrectAnswer = phpResult.correct_answer;
            }

            // Émettre le feedback individuel (pour mettre à jour le score sur le front-end)
            io.to(socketId).emit('feedback_answer', {
                isCorrect: phpResult.is_correct || false,
                correctAnswer: finalCorrectAnswer || ''
            });
        }
    }
    
    // Fallback pour récupérer la réponse correcte si personne n'a répondu
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

    // --- 2. Révélation de la Réponse à tous ---
    if (finalCorrectAnswer) {
        io.emit('reveal_answer', { correctAnswer: finalCorrectAnswer });
    }

    // --- 3. Préparation pour la prochaine question ---
    // CET APPEL MET À JOUR LE SCORE SUR TOUS LES CLIENTS AVEC LA VALEUR DE LA BDD
    await updatePlayersState(); 

    currentQuestionIndex++;
    
    // Démarrer la prochaine question après un court délai pour la visualisation (e.g., 5 secondes)
    setTimeout(startQuestionRound, 5000); 
}


// Logique de fin de jeu
async function endGame() {
    gameStarted = false;
    currentQuestionIndex = 0;
    questions = [];
    currentAnswers = {};
    if (questionTimer) clearTimeout(questionTimer);

    console.log("Jeu terminé. Envoi des scores finaux.");

    // Récupérer le classement final
    try {
        const response = await axios.get(`${PHP_API_URL}/leaderboard`);
        const finalScores = response.data;
        io.emit('final_scores', finalScores);
        io.emit('quiz_end');
        
        // Réinitialiser l'état du jeu dans la BDD
        await axios.post(`${PHP_API_URL}/game/reset`); // Supposons que cette route existe
    } catch (error) {
        console.error("Erreur lors de la récupération du classement:", error.message);
    }
}


// ------------------------------------------
// Gestion des Sockets (Connexions/Événements)
// ------------------------------------------
io.on('connection', (socket) => {
    console.log(`Utilisateur connecté: ${socket.id}`);

    // Synchroniser l'état initial des joueurs
    updatePlayersState(); 

    // Gérer l'état initial du jeu
    axios.get(`${PHP_API_URL}/game/status`).then(res => {
        if (res.data.started) {
             socket.emit('game_started');
        }
    });

    socket.on('disconnect', () => {
        console.log(`Utilisateur déconnecté: ${socket.id}`);
        // Retirer le joueur déconnecté du tableau, basé sur l'ID socket
        connectedPlayers = connectedPlayers.filter(p => p.id !== socket.id);
        updatePlayersState(); // Mise à jour pour les autres clients
    });

    socket.on('player_info', (playerInfo) => {
        // Enregistrer l'ID socket du joueur pour le suivi en temps réel
        if (playerInfo && !connectedPlayers.find(p => p.id === socket.id)) {
            connectedPlayers.push({
                id: socket.id,
                participantId: playerInfo.participantId, // ID BDD du participant
                pseudo: playerInfo.pseudo,
                is_admin: playerInfo.is_admin,
                score: 0,
                is_ready: false,
                has_answered_current_q: false,
            });
            updatePlayersState();
        }
    });
    
    // ************************************************
    // TRAITEMENT DE LA RÉPONSE : CACHÉE (PAS DE SCORING IMMÉDIAT)
    // ************************************************
    socket.on('player_answer', (data) => {
        const player = connectedPlayers.find(p => p.id === socket.id);
        
        // Vérifier si la question est active et si le joueur n'a pas déjà répondu
        if (gameStarted && player && currentQuestionIndex < questions.length && !currentAnswers[socket.id]) {
            const currentQ = questions[currentQuestionIndex];
            
            if (data.question_id === currentQ.id) {
                // Stocker la réponse dans le cache
                currentAnswers[socket.id] = {
                    question_id: data.question_id,
                    answer: data.answer
                };
                
                console.log(`Réponse cachée pour ${player.pseudo}. ID: ${data.question_id}`);
                
                // Mettre à jour l'état visuel "a répondu"
                updatePlayersState(); 
            }
        }
    });
    
    // Gérer le signal de début de partie par l'administrateur
    socket.on('start_game_request', async () => {
        if (gameStarted) return; 

        // Récupérer les 10 questions aléatoires via l'API PHP (qui gère l'unicité)
        questions = await fetchPhpApi('/quiz/questions', { userId: 1 });
        
        if (questions.length === 0) {
            console.log("Pas de questions disponibles.");
            io.emit('error_message', '❌ Aucune question valide reçue de l\'API. Le stock est vide.');
            return;
        }

        // Réinitialiser les scores des joueurs avant le début
        await fetchPhpApi('/game/reset_scores'); 
        
        gameStarted = true;
        currentQuestionIndex = 0;
        
        io.emit('game_started'); // Notifier tous les clients
        startQuestionRound(); // Démarrer la première question
    });
});

// Middleware pour la réinitialisation de l'état
app.post('/api/game/reset', async (req, res) => {
    gameStarted = false;
    currentQuestionIndex = 0;
    questions = [];
    currentAnswers = {};
    if (questionTimer) clearTimeout(questionTimer);
    
    try {
        // Réinitialisation des états is_ready et game_started dans la BDD
        await axios.post(`${PHP_API_URL}/game/reset-participants-state`); 
        return res.json({ success: true, message: 'Jeu réinitialisé' });
    } catch (error) {
        console.error("Erreur lors de la réinitialisation de la BDD:", error.message);
        return res.status(500).json({ error: 'Erreur de réinitialisation BDD' });
    }
});


httpServer.listen(PORT, () => {
    console.log(`Serveur Node.js en cours d'exécution sur le port ${PORT}`);
});
