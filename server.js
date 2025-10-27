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

// URL de l'API PHP (Heroku ou locale)
// IMPORTANT : L'URL Heroku est définie ici si la variable d'environnement PHP_API_URL n'est pas présente.
// L'URL de base est : https://quiz-api-fafaw945.herokuapp.com/
const PHP_API_URL = process.env.PHP_API_URL || 'https://quiz-api-fafaw945.herokuapp.com'; 
const PORT = process.env.PORT || 3001;

// ------------------------------------------
// État du Jeu Global
// ------------------------------------------
let connectedPlayers = []; // Stocke les joueurs actuellement connectés par socket.id
let gameStarted = false;
let currentQuestionIndex = 0;
let questions = []; // Cache des 10 questions récupérées de l'API
let questionTimer = null; // Référence au minuteur Node.js (pour le délai)

// Suivi des réponses soumises pendant le temps imparti
let currentAnswers = {}; // { socketId: { question_id: string, answer: string } }
// La réponse correcte sera déterminée et stockée après l'appel API

const QUESTION_TIME_LIMIT = 15; // 15 secondes par question
const REVEAL_TIME = 5000; // 5 secondes pour la révélation de la réponse

// Fonction utilitaire pour appeler l'API PHP (POST par défaut)
async function fetchPhpApi(endpoint, data = null, method = 'POST') {
    try {
        // Construction de l'URL complète avec l'endpoint et le chemin /api
        const url = `${PHP_API_URL}/api${endpoint}`; 
        let response;

        if (method === 'POST') {
            response = await axios.post(url, data);
        } else if (method === 'GET') {
             response = await axios.get(url);
        }
        
        return response.data;
    } catch (error) {
        // Log l'erreur d'API de manière claire
        console.error(`Erreur lors de l'appel à l'API PHP ${endpoint}:`, error.response ? error.response.data : error.message);
        return { error: 'Erreur d\'API' };
    }
}

// Mettre à jour et émettre l'état des joueurs
async function updatePlayersState() {
    try {
        // Récupère l'état 'is_ready', 'is_admin', 'pseudo' de la BDD pour tous les participants
        const dbPlayers = await fetchPhpApi('/players/ready-list', null, 'GET'); 

        // Filtrer les joueurs de la BDD qui sont actuellement connectés via Socket.io
        const newPlayersState = dbPlayers.map(dbPlayer => {
            // Trouver l'état de connexion Socket.io pour lier l'ID socket
            const connectedPlayer = connectedPlayers.find(p => p.pseudo === dbPlayer.pseudo);
            
            // Si le joueur est dans la BDD mais pas connecté au Socket.io, l'ignorer pour la liste temps réel
            if (!connectedPlayer) return null; 

            return {
                id: connectedPlayer.id, // ID du socket (pour cibler les messages)
                participantId: connectedPlayer.participantId, // ID BDD original
                pseudo: dbPlayer.pseudo,
                score: parseInt(dbPlayer.score || 0),
                is_admin: dbPlayer.is_admin,
                is_ready: dbPlayer.is_ready,
                // Le joueur a-t-il soumis une réponse pour la question actuelle ?
                has_answered_current_q: !!currentAnswers[connectedPlayer.id],
            };
        }).filter(p => p !== null); 

        // Mettre à jour l'état global et notifier les clients
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
    
    // Réinitialiser l'état des réponses locales
    currentAnswers = {}; 

    console.log(`Démarrage question ${currentQuestionIndex + 1}: ${currentQ.question}`);
    
    // Émission de la nouvelle question
    io.emit('new_question', {
        questionNumber: currentQuestionIndex + 1,
        totalQuestions: questions.length,
        id: currentQ.id,
        questionText: currentQ.question,
        options: currentQ.answers, // Utilise la clé 'answers'
        timeLimit: QUESTION_TIME_LIMIT
    });
    
    // Lancer le minuteur qui DÉCLENCHERA LE SCORING
    if (questionTimer) clearTimeout(questionTimer);
    questionTimer = setTimeout(processQuestionEnd, QUESTION_TIME_LIMIT * 1000);

    // Mettre à jour l'état des joueurs (pour réinitialiser l'indicateur "answered" sur le front)
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
            // APPEL PHP POUR SCORING : Mise à jour du score dans la BDD
            const phpResult = await fetchPhpApi('/quiz/answer', {
                player_id: player.participantId, 
                question_id: questionId,
                answer: answerText
            });

            // Stocker la réponse correcte pour l'étape de révélation
            if (phpResult && phpResult.correct_answer) {
                finalCorrectAnswer = phpResult.correct_answer;
            }

            // Émettre le feedback individuel (pour les sons/effets locaux)
            io.to(socketId).emit('feedback_answer', {
                isCorrect: phpResult.is_correct || false,
                correctAnswer: finalCorrectAnswer || '' // Envoie la réponse correcte seulement si la réponse du joueur était fausse
            });
        }
    }
    
    // --- 2. Récupération de la réponse correcte finale (si non définie) ---
    // Cette étape est nécessaire si aucun joueur n'a répondu
    if (!finalCorrectAnswer) {
        const phpResult = await fetchPhpApi('/quiz/answer', { 
            player_id: 0, // ID factice
            question_id: questionId,
            answer: "" // Réponse vide
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
    // Mettre à jour le score visible sur tous les clients
    await updatePlayersState(); 

    currentQuestionIndex++;
    
    // Démarrer la prochaine question après un court délai pour la visualisation
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

    // Récupérer le classement final via l'API PHP
    try {
        const finalScores = await fetchPhpApi('/leaderboard', null, 'GET');
        
        // 1. Émettre les scores finaux
        io.emit('final_scores', finalScores);
        // 2. Émettre le signal de fin de quiz
        io.emit('quiz_end');
        
        // 3. Réinitialiser l'état du jeu (is_used, scores, is_ready, game_started) dans la BDD
        const resetResult = await fetchPhpApi('/game/reset', { admin_id: 1 }); // Admin ID 1
        console.log("État du jeu BDD réinitialisé:", resetResult);
        
        // 4. Mettre à jour l'état des joueurs pour les renvoyer au lobby
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

    // Synchroniser l'état initial des joueurs
    updatePlayersState(); 

    // Événement appelé par le client après la connexion et l'authentification
    socket.on('player_info', (playerInfo) => {
        // Enregistrer l'ID socket du joueur pour le suivi en temps réel
        if (playerInfo && !connectedPlayers.find(p => p.id === socket.id)) {
            connectedPlayers.push({
                id: socket.id,
                participantId: playerInfo.participantId, // ID BDD du participant
                pseudo: playerInfo.pseudo,
                is_admin: playerInfo.is_admin,
                score: 0, // Le score initial sera mis à jour par updatePlayersState()
                is_ready: false,
                has_answered_current_q: false,
            });
            updatePlayersState();
        }
    });
    
    // Déconnexion
    socket.on('disconnect', () => {
        console.log(`Utilisateur déconnecté: ${socket.id}`);
        // Retirer le joueur déconnecté du tableau
        connectedPlayers = connectedPlayers.filter(p => p.id !== socket.id);
        updatePlayersState(); // Mise à jour pour les autres clients
    });
    
    // ************************************************
    // TRAITEMENT DE LA RÉPONSE : CACHÉE
    // ************************************************
    socket.on('player_answer', (data) => {
        const player = connectedPlayers.find(p => p.id === socket.id);
        
        // Vérifier si la partie est en cours, si le joueur existe, si la question est active et si le joueur n'a pas déjà répondu
        if (gameStarted && player && currentQuestionIndex < questions.length && !currentAnswers[socket.id]) {
            const currentQ = questions[currentQuestionIndex];
            
            if (data.question_id === currentQ.id) {
                // Stocker la réponse dans le cache local (SCORING au moment du timer)
                currentAnswers[socket.id] = {
                    question_id: data.question_id,
                    answer: data.answer
                };
                
                console.log(`Réponse stockée pour ${player.pseudo}.`);
                
                // Mettre à jour l'état visuel "a répondu" pour tous les clients
                updatePlayersState(); 
            }
        }
    });
    
    // Gérer le signal de début de partie par l'administrateur
    socket.on('start_game_request', async (data) => {
        if (gameStarted) return; 
        
        // Validation basique de l'admin
        const player = connectedPlayers.find(p => p.id === socket.id);
        if (!player || !player.is_admin) {
            socket.emit('error_message', 'Action réservée à l’administrateur.');
            return;
        }

        // Récupérer les questions aléatoires via l'API PHP (qui gère l'unicité et la réinitialisation)
        questions = await fetchPhpApi('/quiz/questions', { userId: player.participantId });
        
        if (questions.length === 0) {
            console.error("Erreur: Pas de questions disponibles.");
            io.emit('error_message', '❌ Aucune question valide reçue de l\'API. Le stock est peut-être vide ou l\'API est inaccessible.');
            return;
        }

        console.log(`Début du jeu avec ${questions.length} questions.`);

        // Réinitialiser les scores, etc., dans la BDD pour commencer propre
        const resetResult = await fetchPhpApi('/game/reset', { admin_id: player.participantId });
        console.log("Réinitialisation avant jeu:", resetResult);
        
        gameStarted = true;
        currentQuestionIndex = 0;
        
        io.emit('game_started'); // Notifier tous les clients pour changer de vue
        startQuestionRound(); // Démarrer la première question
    });
});


httpServer.listen(PORT, () => {
    console.log(`Serveur Node.js Socket.io en cours d'exécution sur le port ${PORT}`);
    console.log(`API PHP ciblée à: ${PHP_API_URL}`);
});
