import { createServer } from "http";
import { Server } from "socket.io";
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());

const server = createServer(app);
const io = new Server(server, {
    cors: { origin: "http://localhost:3000", methods: ["GET", "POST"] },
});

// =======================================================
// 🚨 CONFIGURATION API PHP (Vérifiez le port !)
// =======================================================
const PHP_HOST = "http://localhost:8000";
const QUESTIONS_API_URL = `${PHP_HOST}/api/quiz/questions`;
const ANSWER_API_URL = `${PHP_HOST}/api/quiz/answer`;
const DELETE_QUESTIONS_API_URL = `${PHP_HOST}/api/questions/delete`;

let players = []; 
let gameStarted = false;

// VARIABLES QUIZ CENTRALES
let questions = []; 
let currentQuestionIndex = -1; 
let questionTimer = null; 
const TIME_PER_QUESTION = 10; 
const REVEAL_TIME = 3000; 


// === Fonctions de Contrôle et API === 

const deletePlayedQuestions = async (ids) => {
    if (ids.length === 0) return;
    
    try {
        await fetch(DELETE_QUESTIONS_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
        });
        console.log(`[ADMIN] ✅ Questions ${ids.join(', ')} supprimées de la BDD.`);
    } catch (err) {
        console.error("🚫 Erreur suppression:", err.message);
    }
}; 

const loadAndConsumeQuestions = async () => {
    questions = []; 
    try {
        const res = await fetch(QUESTIONS_API_URL);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const data = await res.json();
        
        if (Array.isArray(data) && data.length > 0) {
            questions = data;
            await deletePlayedQuestions(data.map(q => q.id)); 
            return questions.length;
        } else {
            console.warn("❌ Aucune question valide reçue de l'API.");
            return 0;
        }
    } catch (err) {
        console.error("❌ Erreur critique au fetch des questions:", err.message);
        return 0;
    }
}; 

/** Diffuse la liste des joueurs avec leurs scores et statuts mis à jour. */
const updatePlayers = () => {
    io.emit("players_update", players.map(p => ({
        id: p.id,
        pseudo: p.pseudo,
        ready: p.ready,
        is_admin: p.is_admin,
        score: p.score,
        has_answered_current_q: p.has_answered_current_q // Utile pour le front
    })));
} 

const revealAnswer = (question) => {
    io.emit("reveal_answer", {
        correctAnswer: question.correct_answer || "Erreur",
        nextQuestionTime: REVEAL_TIME 
    });
    console.log(`[QUIZ] 📢 Révélation de la réponse.`);
    setTimeout(nextQuestion, REVEAL_TIME); 
} 

const nextQuestion = () => {
    if (questionTimer) {
        clearTimeout(questionTimer);
    }

    currentQuestionIndex++;
    
    if (currentQuestionIndex < questions.length) {
        // Réinitialiser le statut de réponse
        players = players.map(p => ({...p, has_answered_current_q: false}));
        updatePlayers(); // Diffuser l'état de début de question
        
        const question = questions[currentQuestionIndex];
        io.emit("new_question", {
            id: question.id, 
            questionNumber: currentQuestionIndex + 1,
            questionText: question.question,
            options: question.answers, 
            totalQuestions: questions.length,
            timeLimit: TIME_PER_QUESTION
        });
        
        console.log(`[QUIZ] ➡️ Question ${currentQuestionIndex + 1} envoyée.`);
        questionTimer = setTimeout(() => { revealAnswer(question); }, TIME_PER_QUESTION * 1000); 
    } else {
        // Fin du quiz
        const finalScores = players.map(p => ({ pseudo: p.pseudo, score: p.score })).sort((a, b) => b.score - a.score);
        io.emit("final_scores", finalScores); 
        io.emit("quiz_end");
        console.log("🚀 Quiz terminé.");
        gameStarted = false;
        currentQuestionIndex = -1;
    }
} 


// === Événements Socket.io === 
io.on("connection", (socket) => {
    console.log(`🟢 Nouveau joueur connecté: ${socket.id.substring(0, 4)}...`);

    // 🔹 Le joueur rejoint le lobby
    socket.on("join_lobby", ({ pseudo, participantId }) => { 
        if (players.some(p => p.id === socket.id)) return;
        
        const isAdmin = players.length === 0; 
        players.push({ 
            id: socket.id, 
            participant_id_bdd: participantId, // 🔑 STOCKAGE DE L'ID BDD
            pseudo, 
            ready: isAdmin, 
            is_admin: isAdmin,
            score: 0,
            has_answered_current_q: false
        });
        
        updatePlayers(); 
    });

    // 🔹 Joueur indique qu'il est prêt
    socket.on("player_ready", () => {
        players = players.map((p) =>
            p.id === socket.id ? { ...p, ready: true } : p
        );
        updatePlayers(); 
    });
    
    // 🔹 Joueur envoie sa réponse
    socket.on("player_answer", async ({ question_id, answer }) => {
        if (!gameStarted || currentQuestionIndex === -1) return;

        const player = players.find(p => p.id === socket.id);
        
        if (!player || player.has_answered_current_q) return;
        
        // 1. Marquer le joueur comme ayant répondu immédiatement 
        player.has_answered_current_q = true; 
        updatePlayers(); 

        try {
            const res = await fetch(ANSWER_API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    player_id: player.participant_id_bdd, // 🔑 Utilisation de l'ID BDD
                    question_id,
                    answer: answer, 
                }),
            });

            if (!res.ok) throw new Error(`API call failed with status: ${res.status}`);

            const data = await res.json();
            const isCorrect = data.is_correct || false;

            if (isCorrect) {
                // 2. Mise à jour du score local (en mémoire)
                player.score += (data.score_earned || 1); 
                console.log(`[SCORE] ${player.pseudo} a bien répondu. Nouveau score: ${player.score}`);
            }
            
            socket.emit("feedback_answer", { isCorrect, submittedAnswer: answer }); 
            updatePlayers(); // 3. Diffuser les nouveaux scores
            

        } catch (err) {
            console.error("Erreur critique lors de la vérification de réponse:", err.message);
        }
    });


    // 🔹 Admin lance la partie
    socket.on("start_game", async () => {
        const adminPlayer = players.find(p => p.id === socket.id && p.is_admin);
        if (!adminPlayer || gameStarted) return;
        
        const questionCount = await loadAndConsumeQuestions();
        
        if (questionCount > 0) {
            gameStarted = true;
            players = players.map(p => ({...p, score: 0, has_answered_current_q: false})); 
            console.log("🚀 Partie lancée !");
            io.emit("game_start"); 
            setTimeout(nextQuestion, 2000); 
        } else {
            console.warn('🚫 Lancement annulé: 0 questions disponibles.');
        }
    });

    // 🔹 Joueur se déconnecte 
    socket.on("disconnect", () => {
        const wasAdmin = players.find(p => p.id === socket.id)?.is_admin;
        players = players.filter((p) => p.id !== socket.id);
        
        if (wasAdmin && players.length > 0) {
            players[0].is_admin = true;
            players[0].ready = true;
        }

        updatePlayers(); 
    });
}); 


server.listen(8001, () => {
    console.log("🟢 Serveur WebSocket lancé sur le port 8001");
});