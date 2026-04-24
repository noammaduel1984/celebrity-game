"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { db } from "@/lib/firebase";
import { doc, onSnapshot, updateDoc } from "firebase/firestore";

// --- Types ---
interface Player {
  name: string;
  team: number;
  hasPlayed: boolean;
  ready: boolean;
}

interface RoomData {
  status: "waiting" | "playing" | "finished";
  turnState: "idle" | "active" | "paused" | "summary";
  currentRound: number;
  currentTeamIndex: number;
  currentPlayerTurn: string;
  players: Player[];
  teamScores: number[];
  celebrities: string[];
  activeDeck: string[];
  host: string;
  numTeams: number;
  turnEndTime: number | null;
  turnTimeLeft: number;
  currentTurnWords: string[]; // מילים שנוחשו בתור הנוכחי
  roundDurations: { r1: number; r2: number; r3: number };
}

// --- Helpers: Audio & Haptics ---
const playTickSound = () => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 800;
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
    osc.start();
    osc.stop(ctx.currentTime + 0.1);
  } catch (e) { /* התעלם אם הדפדפן לא תומך */ }
};

const triggerVibration = (pattern: number | number[]) => {
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    navigator.vibrate(pattern);
  }
};

// --- Main Component ---
export default function RoomPage() {
  const params = useParams();
  const router = useRouter();
  const roomId = params.id as string;
  
  const [roomData, setRoomData] = useState<RoomData | null>(null);
  const [localName, setLocalName] = useState("");
  const [currentName, setCurrentName] = useState("");
  const [timeLeft, setTimeLeft] = useState(0);
  const [hasSkipped, setHasSkipped] = useState(false);
  const [unusableInTurn, setUnusableInTurn] = useState<string[]>([]);
  
  // הגדרות זמנים למנהל
  const [durations, setDurations] = useState({ r1: 60, r2: 45, r3: 90 });

  const wakeLockRef = useRef<any>(null);
  const isEndingTurn = useRef(false);

  // אתחול מקומי והאזנה לפיירבייס
  useEffect(() => {
    const savedName = localStorage.getItem("playerName");
    if (!savedName) {
      router.push("/");
      return;
    }
    setLocalName(savedName);

    if (!roomId) return;
    const unsub = onSnapshot(doc(db, "rooms", roomId), (docSnap) => {
      if (docSnap.exists()) setRoomData(docSnap.data() as RoomData);
    });
    return () => unsub();
  }, [roomId, router]);

  // חזרה ללובי אם אין מילים
  useEffect(() => {
    if (roomData?.status === "waiting" && (!roomData.celebrities || roomData.celebrities.length === 0)) {
      router.push(`/`); 
    }
  }, [roomData?.status, roomData?.celebrities, router]);

  // ניהול Wake Lock (השארת מסך דולק)
  useEffect(() => {
    const manageWakeLock = async () => {
      if (roomData?.currentPlayerTurn === localName && roomData?.turnState === "active") {
        try {
          if ('wakeLock' in navigator) {
            wakeLockRef.current = await navigator.wakeLock.request('screen');
          }
        } catch (err) {}
      } else {
        if (wakeLockRef.current) {
          wakeLockRef.current.release();
          wakeLockRef.current = null;
        }
      }
    };
    manageWakeLock();
  }, [roomData?.turnState, roomData?.currentPlayerTurn, localName]);

  // טיימר מרכזי
  useEffect(() => {
    if (roomData?.turnState === "active" && roomData?.turnEndTime) {
      const interval = setInterval(() => {
        const now = Date.now();
        const diff = Math.max(0, Math.floor((roomData.turnEndTime! - now) / 1000));
        setTimeLeft(diff);

        // אפקטים ב-10 השניות האחרונות
        if (diff > 0 && diff <= 10) {
          playTickSound();
          triggerVibration(50);
        }
        
        // סיום זמן
        if (diff === 0 && roomData.currentPlayerTurn === localName) {
          goToSummary(0);
        }
      }, 1000);
      return () => clearInterval(interval);
    } else if (roomData?.turnState === "paused") {
      setTimeLeft(roomData.turnTimeLeft);
    } else if (roomData?.turnState === "idle") {
      // הצגת הזמן ההתחלתי לפני שלוחצים "התחל"
      const roundKey = `r${roomData.currentRound}` as keyof typeof roomData.roundDurations;
      setTimeLeft(roomData?.roundDurations?.[roundKey] || 60);
    }
  }, [roomData?.turnState, roomData?.turnEndTime, roomData?.turnTimeLeft, roomData?.currentRound, localName]);

  const startGame = async () => {
    if (!roomData?.celebrities?.length) return;
    const players = roomData.players.map(p => ({ ...p, hasPlayed: false }));
    const firstPlayer = players.find(p => p.team === 0) || players[0];

    await updateDoc(doc(db, "rooms", roomId), {
      status: "playing",
      currentRound: 1,
      currentTeamIndex: 0,
      currentPlayerTurn: firstPlayer.name,
      teamScores: new Array(roomData.numTeams || 2).fill(0),
      activeDeck: roomData.celebrities,
      players: players.map(p => p.name === firstPlayer.name ? { ...p, hasPlayed: true } : p),
      turnState: "idle",
      turnEndTime: null,
      currentTurnWords: [],
      roundDurations: durations // שמירת הגדרות הזמן של המנהל
    });
  };

  const startMyTurn = async () => {
    if (!roomData) return;
    setHasSkipped(false);
    setUnusableInTurn([]); 
    
    const roundKey = `r${roomData.currentRound}` as keyof typeof roomData.roundDurations;
    const duration = roomData.roundDurations[roundKey] || 60;
    
    const endTime = Date.now() + (duration * 1000) + 500; // חצי שנייה גרייס
    
    await updateDoc(doc(db, "rooms", roomId), { 
      turnState: "active",
      turnEndTime: endTime,
      currentTurnWords: []
    });
    drawNextName(roomData.activeDeck, []);
  };

  const pauseTurn = async () => {
    await updateDoc(doc(db, "rooms", roomId), {
      turnState: "paused",
      turnTimeLeft: timeLeft,
      turnEndTime: null
    });
  };

  const resumeTurn = async () => {
    const endTime = Date.now() + (roomData!.turnTimeLeft * 1000);
    await updateDoc(doc(db, "rooms", roomId), {
      turnState: "active",
      turnEndTime: endTime,
      turnTimeLeft: 0
    });
  };

  const goToSummary = async (finalTimeLeft: number) => {
    await updateDoc(doc(db, "rooms", roomId), {
      turnState: "summary",
      turnEndTime: null,
      turnTimeLeft: finalTimeLeft
    });
    setCurrentName("");
  };

  const drawNextName = (deck: string[], unusable: string[]) => {
    const available = deck.filter(n => !unusable.includes(n));
    if (available.length === 0) {
      // אם הכובע התרוקן, הולכים לסיכום עם הזמן שנשאר
      goToSummary(timeLeft);
      return;
    }
    setCurrentName(available[Math.floor(Math.random() * available.length)]);
  };

  const handleSuccess = async () => {
    if (!roomData) return;
    triggerVibration([100, 50, 100]); // רטט שמח לניחוש נכון

    const newDeck = [...roomData.activeDeck];
    const wordIndex = newDeck.indexOf(currentName);
    if (wordIndex > -1) newDeck.splice(wordIndex, 1);

    const newScores = [...roomData.teamScores];
    newScores[roomData.currentTeamIndex]++;

    const newTurnWords = [...(roomData.currentTurnWords || []), currentName];

    await updateDoc(doc(db, "rooms", roomId), {
      activeDeck: newDeck,
      teamScores: newScores,
      currentTurnWords: newTurnWords
    });

    if (newDeck.length === 0) {
      goToSummary(timeLeft);
    } else {
      drawNextName(newDeck, unusableInTurn);
    }
  };

  const handleUndo = async () => {
    if (!roomData || roomData.currentTurnWords.length === 0) return;
    
    const words = [...roomData.currentTurnWords];
    const removedWord = words.pop()!; // מוציא את המילה האחרונה שנוחשה

    const newDeck = [...roomData.activeDeck, removedWord];
    const newScores = [...roomData.teamScores];
    newScores[roomData.currentTeamIndex]--; // מוריד נקודה

    await updateDoc(doc(db, "rooms", roomId), {
      activeDeck: newDeck,
      teamScores: newScores,
      currentTurnWords: words
    });
    
    // אם לא הייתה מילה על המסך, נציג את המילה שהחזרנו (או אחרת פנויה)
    if (!currentName) drawNextName(newDeck, unusableInTurn);
  };

  const handleSkip = () => {
    setHasSkipped(true);
    const newUnusable = [...unusableInTurn, currentName];
    setUnusableInTurn(newUnusable);
    drawNextName(roomData!.activeDeck, newUnusable);
  };

  const handleDisqualify = () => {
    const newUnusable = [...unusableInTurn, currentName];
    setUnusableInTurn(newUnusable);
    drawNextName(roomData!.activeDeck, newUnusable);
  };

  const confirmSummaryAndEndTurn = async () => {
    if (isEndingTurn.current || !roomData) return;
    isEndingTurn.current = true;

    try {
      const numTeams = roomData.numTeams || 2;
      const nextTeamIndex = (roomData.currentTeamIndex + 1) % numTeams;
      let updatedPlayers = [...roomData.players];
      
      let eligible = updatedPlayers.filter(p => p.team === nextTeamIndex && !p.hasPlayed);
      if (eligible.length === 0) {
        updatedPlayers = updatedPlayers.map(p => p.team === nextTeamIndex ? { ...p, hasPlayed: false } : p);
        eligible = updatedPlayers.filter(p => p.team === nextTeamIndex);
      }
      if (eligible.length === 0) eligible = updatedPlayers; // Fallback

      const nextPlayer = eligible[Math.floor(Math.random() * eligible.length)];
      updatedPlayers = updatedPlayers.map(p => p.name === nextPlayer.name ? { ...p, hasPlayed: true } : p);

      await updateDoc(doc(db, "rooms", roomId), {
        currentTeamIndex: nextTeamIndex,
        currentPlayerTurn: nextPlayer.name,
        players: updatedPlayers,
        turnState: "idle",
        turnEndTime: null,
        currentTurnWords: []
      });
    } finally {
      setTimeout(() => { isEndingTurn.current = false; }, 1000);
    }
  };

  const nextRound = async () => {
    if (roomData?.currentRound === 3) {
      await updateDoc(doc(db, "rooms", roomId), { status: "finished" });
      return;
    }
    
    const numTeams = roomData!.numTeams || 2;
    const nextTeamIndex = (roomData!.currentTeamIndex + 1) % numTeams;
    let updatedPlayers = [...roomData!.players];
    let eligible = updatedPlayers.filter(p => p.team === nextTeamIndex && !p.hasPlayed);
    
    if (eligible.length === 0) {
      updatedPlayers = updatedPlayers.map(p => p.team === nextTeamIndex ? { ...p, hasPlayed: false } : p);
      eligible = updatedPlayers.filter(p => p.team === nextTeamIndex);
    }

    const nextPlayer = eligible[Math.floor(Math.random() * eligible.length)];
    updatedPlayers = updatedPlayers.map(p => p.name === nextPlayer.name ? { ...p, hasPlayed: true } : p);

    await updateDoc(doc(db, "rooms", roomId), {
      currentRound: roomData!.currentRound + 1,
      activeDeck: roomData!.celebrities, 
      turnState: "idle",
      currentTeamIndex: nextTeamIndex,
      currentPlayerTurn: nextPlayer.name,
      players: updatedPlayers
    });
  };

  const resetGame = async () => {
    const clearedPlayers = roomData!.players.map(p => ({ ...p, hasPlayed: false, ready: false }));
    await updateDoc(doc(db, "rooms", roomId), {
      status: "waiting",
      currentRound: 0,
      celebrities: [], 
      activeDeck: [],
      teamScores: [],
      turnState: "idle",
      currentPlayerTurn: "",
      players: clearedPlayers
    });
  };

  if (!roomData || roomData.status === "waiting") {
    return (
      <main className="flex min-h-screen flex-col items-center bg-slate-50 p-6 text-right" dir="rtl">
        <div className="w-full max-w-md bg-white rounded-3xl p-8 shadow-xl mt-10">
           <h2 className="text-3xl font-black text-slate-800 mb-6 border-b pb-4">הכובע כמעט מוכן! 🎩</h2>
           
           {roomData?.host === localName ? (
             <div className="space-y-6">
               <p className="text-slate-500 font-medium text-sm mb-4">לפני שמתחילים, בחר כמה זמן יהיה לכל סבב:</p>
               
               <div className="space-y-4">
                 {[1, 2, 3].map((r) => (
                   <div key={r} className="flex flex-col gap-2">
                     <label className="text-sm font-bold text-slate-600">
                       סבב {r} {r===1 ? "(חופשי)" : r===2 ? "(מילה אחת)" : "(פנטומימה)"} - <span className="text-blue-600">{durations[`r${r}` as keyof typeof durations]} שניות</span>
                     </label>
                     <input 
                       type="range" min="30" max="120" step="15" 
                       value={durations[`r${r}` as keyof typeof durations]}
                       onChange={(e) => setDurations({...durations, [`r${r}`]: parseInt(e.target.value)})}
                       className="w-full accent-blue-600"
                     />
                   </div>
                 ))}
               </div>

               <div className="pt-6 mt-6 border-t space-y-3">
                 <button onClick={async () => {
                    const shuffled = [...roomData.players].sort(() => Math.random() - 0.5);
                    const updated = shuffled.map((p, i) => ({ ...p, team: i % (roomData.numTeams || 2), hasPlayed: false }));
                    await updateDoc(doc(db, "rooms", roomId), { players: updated });
                 }} className="w-full text-slate-500 font-bold py-3 border-2 border-dashed border-slate-200 rounded-xl">ערבב קבוצות 🔄</button>
                 
                 <button onClick={startGame} className="w-full bg-green-500 text-white py-5 rounded-2xl font-black text-xl shadow-lg hover:bg-green-600 transition">התחל משחק 🚀</button>
               </div>
             </div>
           ) : (
             <div className="text-center py-10 space-y-4">
                <div className="animate-spin text-4xl">⏳</div>
                <p className="text-xl font-bold text-slate-600">מחכים שמנהל החדר יתחיל...</p>
             </div>
           )}
        </div>
      </main>
    );
  }

  const isMyTurn = roomData.status === "playing" && roomData.currentPlayerTurn === localName;
  const isDeckEmpty = roomData.activeDeck?.length === 0;
  const roundDurationKey = `r${roomData.currentRound}` as keyof typeof roomData.roundDurations;
  const maxTime = roomData.roundDurations?.[roundDurationKey] || 60;

  return (
    <main className="flex min-h-screen flex-col items-center bg-slate-50 p-6 text-right" dir="rtl">
      
      {roomData.status === "finished" ? (
         <div className="w-full max-w-md space-y-8 text-center animate-in fade-in zoom-in duration-500">
           {/* מסך סיום נשאר אותו דבר... */}
           <div className="bg-white rounded-[3rem] p-10 shadow-2xl border-4 border-yellow-400">
             <h1 className="text-6xl mb-4">🏆</h1>
             <h2 className="text-4xl font-black text-slate-800 mb-2">המשחק נגמר!</h2>
             <div className="space-y-4 mb-10 mt-8">
               {roomData.teamScores.map((s, i) => (
                 <div key={i} className="flex justify-between items-center bg-slate-50 p-4 rounded-2xl">
                   <span className="font-bold text-slate-600 text-lg">קבוצה {String.fromCharCode(1488 + i)}'</span>
                   <span className="text-3xl font-black text-slate-800">{s} נק'</span>
                 </div>
               ))}
             </div>
             {roomData.host === localName && (
                 <button onClick={resetGame} className="w-full bg-blue-600 text-white py-5 rounded-2xl font-black text-xl shadow-lg">משחק חדש ✨</button>
             )}
           </div>
         </div>
      ) : (
        <>
          {/* Header - סטטוס סבב וניקוד */}
          <div className="w-full max-w-md bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex justify-between items-center mb-6">
            <div>
              <span className="text-xs font-bold text-slate-400 block uppercase">סבב {roomData.currentRound} / 3</span>
              <span className="text-blue-600 font-black">
                {roomData.currentRound === 1 ? 'תיאור חופשי' : roomData.currentRound === 2 ? 'מילה אחת' : 'פנטומימה'}
              </span>
            </div>
            <div className="flex gap-2">
              {roomData.teamScores?.map((score, i) => (
                <div key={i} className={`px-3 py-1 rounded-lg text-center ${roomData.currentTeamIndex === i ? 'bg-blue-600 text-white shadow-md' : 'bg-slate-100 text-slate-500'}`}>
                  <div className="text-[10px] font-bold">ק' {String.fromCharCode(1488 + i)}</div>
                  <div className="font-black leading-none">{score}</div>
                </div>
              ))}
            </div>
          </div>

          {/* מרכז המסך */}
          <div className="w-full max-w-md bg-white rounded-[2.5rem] p-8 shadow-2xl min-h-[450px] flex flex-col justify-center text-center relative overflow-hidden">
            
            {/* מד התקדמות עליון */}
            {(roomData.turnState === "active" || roomData.turnState === "paused") && (
              <div className="absolute top-0 left-0 w-full h-2 bg-slate-100">
                <div className={`h-full transition-all duration-1000 ease-linear ${timeLeft <= 10 ? 'bg-red-500' : 'bg-blue-500'}`} style={{ width: `${(timeLeft / maxTime) * 100}%` }}></div>
              </div>
            )}

            {roomData.turnState === "summary" ? (
              /* --- מסך סיכום תור --- */
              <div className="space-y-6 animate-in slide-in-from-bottom-4">
                <h2 className="text-3xl font-black text-slate-800">התור נגמר! ⏱️</h2>
                <div className="bg-green-50 text-green-700 p-4 rounded-2xl border border-green-100">
                  <p className="text-sm font-bold mb-2">מילים שניחשתם ({roomData.currentTurnWords?.length || 0}):</p>
                  <div className="flex flex-wrap gap-2 justify-center">
                    {roomData.currentTurnWords?.length > 0 ? (
                      roomData.currentTurnWords.map((word, idx) => (
                        <span key={idx} className="bg-white px-3 py-1 rounded-full text-sm font-bold shadow-sm">{word}</span>
                      ))
                    ) : (
                      <span className="text-slate-400">לא הצלחתם לנחש מילים התור... 😢</span>
                    )}
                  </div>
                </div>
                
                {isDeckEmpty && (
                   <div className="bg-blue-50 text-blue-700 p-4 rounded-2xl border border-blue-100 font-bold">
                     הכובע התרוקן! הסבב הזה הסתיים 🎉
                   </div>
                )}

                {isMyTurn ? (
                  <div className="pt-4 space-y-3">
                    {roomData.currentTurnWords?.length > 0 && !isDeckEmpty && (
                       <button onClick={handleUndo} className="w-full text-slate-500 font-bold py-3 underline">
                         רגע, הייתה טעות במילה האחרונה (Undo)
                       </button>
                    )}
                    <button onClick={isDeckEmpty ? nextRound : confirmSummaryAndEndTurn} className="w-full bg-blue-600 text-white py-4 rounded-2xl font-black text-xl shadow-lg">
                      {isDeckEmpty ? "המשך לשלב הבא" : "העבר תור הבא"}
                    </button>
                  </div>
                ) : (
                  <p className="text-slate-400 font-bold animate-pulse">מחכים לשחקן שיאשר את התור...</p>
                )}
              </div>
            ) : roomData.turnState === "idle" ? (
              /* --- לפני תחילת תור --- */
              <div className="space-y-8">
                {!isMyTurn ? (
                  <>
                    <div>
                      <p className="text-slate-400 font-bold text-xs uppercase mb-2">עכשיו בתור</p>
                      <h2 className="text-5xl font-black text-slate-800">{roomData.currentPlayerTurn}</h2>
                    </div>
                    <div className="text-blue-500 font-bold bg-blue-50 py-3 rounded-xl border border-blue-100">
                      מחכים שיתחיל את התור...
                    </div>
                  </>
                ) : (
                  <>
                    <h2 className="text-4xl font-black text-green-600 leading-tight">התור שלך!</h2>
                    <p className="text-slate-500 text-sm">הקבוצה שלך מוכנה? מילים שנפסלו יחזרו לכובע בתור הבא.</p>
                    <button onClick={startMyTurn} className="w-full bg-green-500 text-white py-8 rounded-3xl font-black text-4xl shadow-2xl active:scale-95 transition">התחל ⏳</button>
                  </>
                )}
              </div>
            ) : (
              /* --- תוך כדי משחק / מושהה --- */
              <div className={`space-y-8 transition-opacity ${roomData.turnState === "paused" ? "opacity-50 pointer-events-none" : ""}`}>
                <div className="flex justify-between items-start">
                   {/* כפתור Undo קטן למעלה */}
                   {isMyTurn && roomData.currentTurnWords?.length > 0 && (
                     <button onClick={handleUndo} className="text-xs bg-slate-100 text-slate-600 px-3 py-2 rounded-lg font-bold shadow-sm active:bg-slate-200">
                       ↩️ בטל ניחוש קודם
                     </button>
                   )}
                   <div className={`text-6xl font-black tabular-nums mx-auto ${timeLeft <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-800'}`}>
                     {timeLeft}
                   </div>
                   {/* מקום ריק לאיזון (flex) */}
                   {isMyTurn && roomData.currentTurnWords?.length > 0 && <div className="w-[100px]"></div>}
                </div>

                <div className="bg-slate-50 py-12 px-6 rounded-[2rem] border-2 border-slate-100 shadow-inner min-h-[160px] flex items-center justify-center">
                  <p className="text-4xl font-black text-slate-800 break-words">{currentName}</p>
                </div>
                
                {isMyTurn && (
                  <div className="grid grid-cols-3 gap-3">
                    <button onClick={handleDisqualify} className="bg-orange-100 text-orange-700 py-4 rounded-2xl font-bold active:scale-95 transition">פסילה 🛑</button>
                    <button onClick={handleSkip} disabled={hasSkipped} className={`py-4 rounded-2xl font-bold active:scale-95 transition border ${hasSkipped ? 'bg-slate-50 text-slate-300' : 'bg-white text-slate-600 border-slate-200 shadow-sm'}`}>
                      {hasSkipped ? 'נוצל' : 'דילוג ⏭️'}
                    </button>
                    <button onClick={handleSuccess} className="bg-green-500 text-white py-4 rounded-2xl font-black text-xl shadow-lg active:scale-95 transition">צדקתי! ✅</button>
                  </div>
                )}
              </div>
            )}

            {/* כפתור השהייה מרחף */}
            {isMyTurn && roomData.turnState === "active" && (
              <button onClick={pauseTurn} className="absolute top-4 left-4 bg-slate-100 p-3 rounded-full text-slate-600 shadow-sm">
                ⏸️
              </button>
            )}
            {isMyTurn && roomData.turnState === "paused" && (
              <div className="absolute inset-0 bg-white/80 backdrop-blur-sm flex flex-col items-center justify-center z-10 space-y-6">
                <h3 className="text-4xl font-black text-slate-800">מושהה ⏸️</h3>
                <button onClick={resumeTurn} className="bg-blue-600 text-white px-10 py-4 rounded-2xl font-black text-2xl shadow-xl">המשך מאותו מקום</button>
              </div>
            )}
          </div>

          {/* פוטר - רשימת שחקנים ופתקים */}
          <div className="mt-8 flex flex-col items-center gap-4 w-full max-w-md">
            <div className="bg-white/50 px-4 py-2 rounded-full border border-slate-200 text-slate-500 text-sm font-bold flex gap-2">
              <span>פתקים בכובע: <strong className="text-blue-600">{roomData.activeDeck?.length || 0}</strong></span>
              <span className="text-slate-300">|</span>
              <span>נוחשו עכשיו: <strong className="text-green-600">{roomData.currentTurnWords?.length || 0}</strong></span>
            </div>
            <div className="flex gap-2 overflow-x-auto w-full pb-4 no-scrollbar justify-center">
              {roomData.players?.map((p) => (
                <div key={p.name} className={`flex-shrink-0 px-3 py-1 rounded-full text-[10px] font-bold border ${p.name === roomData.currentPlayerTurn ? 'bg-blue-600 text-white border-blue-600 shadow-md' : 'bg-white text-slate-400'}`}>
                  {p.name} (ק' {String.fromCharCode(1488 + p.team)}) {p.hasPlayed && "✓"}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </main>
  );
}
