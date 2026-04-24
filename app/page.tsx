"use client";

import { useState, useEffect } from "react";
import { db } from "@/lib/firebase";
import { doc, setDoc, updateDoc, getDoc, onSnapshot, serverTimestamp, arrayUnion } from "firebase/firestore";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  const [step, setStep] = useState<"entry" | "lobby" | "settings" | "writing">("entry");
  const [playerName, setPlayerName] = useState("");
  const [roomId, setRoomId] = useState("");
  const [roomData, setRoomData] = useState<any>(null);
  const [numTeams, setNumTeams] = useState(2);
  const [names, setNames] = useState(["", "", "", "", ""]);
  const [loading, setLoading] = useState(false);

  // האזנה לחדר ברגע שיש roomId
  useEffect(() => {
    if (!roomId) return;
    const unsub = onSnapshot(doc(db, "rooms", roomId), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setRoomData(data);
        if (data.status === "writing" && step === "lobby") setStep("writing");
        if (data.status === "playing") router.push(`/room/${roomId}`);
      }
    });
    return () => unsub();
  }, [roomId, step]);

  const createRoom = async () => {
    if (!playerName.trim()) return alert("נא להזין שם");
    const id = Math.floor(100000 + Math.random() * 900000).toString();
    const initialPlayer = { name: playerName, team: 0, isHost: true };
    await setDoc(doc(db, "rooms", id), {
      host: playerName,
      status: "lobby",
      createdAt: serverTimestamp(),
      players: [initialPlayer],
      celebrities: [],
      numTeams: 2
    });
    setRoomId(id);
    setStep("lobby");
    localStorage.setItem("playerName", playerName);
  };

  const joinRoom = async (code: string) => {
    if (!playerName.trim() || !code.trim()) return alert("מלא שם וקוד");
    const roomRef = doc(db, "rooms", code);
    const snap = await getDoc(roomRef);
    if (snap.exists()) {
      await updateDoc(roomRef, {
        players: arrayUnion({ name: playerName, team: 0, isHost: false })
      });
      setRoomId(code);
      setStep("lobby");
      localStorage.setItem("playerName", playerName);
    } else {
      alert("חדר לא נמצא");
    }
  };

  // פונקציות ניהול למנהל
  const shuffleTeams = async () => {
    const shuffled = [...roomData.players].sort(() => 0.5 - Math.random())
      .map((p, i) => ({ ...p, team: i % numTeams }));
    await updateDoc(doc(db, "rooms", roomId), { players: shuffled, numTeams });
  };

  const changePlayerTeam = async (pName: string) => {
    const updated = roomData.players.map((p: any) => 
      p.name === pName ? { ...p, team: (p.team + 1) % numTeams } : p
    );
    await updateDoc(doc(db, "rooms", roomId), { players: updated });
  };

  const startWriting = async () => {
    await updateDoc(doc(db, "rooms", roomId), { status: "writing" });
    setStep("writing");
  };

  const submitNames = async () => {
    if (names.some(n => !n.trim())) return alert("מלא 5 שמות");
    await updateDoc(doc(db, "rooms", roomId), {
      celebrities: arrayUnion(...names)
    });
    router.push(`/room/${roomId}`);
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gray-50 p-6 text-right" dir="rtl">
      <div className="w-full max-w-md space-y-6 rounded-3xl bg-white p-8 shadow-xl">
        
        {step === "entry" && (
          <div className="space-y-4">
            <h1 className="text-3xl font-black text-center text-blue-600">Celebrity Game</h1>
            <input placeholder="השם שלך" className="w-full p-4 border-2 rounded-xl" onChange={e => setPlayerName(e.target.value)} />
            <button onClick={createRoom} className="w-full bg-blue-600 text-white p-4 rounded-xl font-bold">צור חדר</button>
            <div className="flex gap-2">
              <input placeholder="קוד" className="flex-1 p-4 border-2 rounded-xl" id="joinCode" />
              <button onClick={() => joinRoom((document.getElementById('joinCode') as HTMLInputElement).value)} className="bg-gray-800 text-white px-6 rounded-xl font-bold">הצטרף</button>
            </div>
          </div>
        )}

        {step === "lobby" && roomData && (
          <div className="space-y-6 text-center">
            <div className="bg-blue-50 p-4 rounded-xl">
              <p className="text-sm font-bold text-blue-400">קוד חדר</p>
              <p className="text-4xl font-mono font-black text-blue-700">{roomId}</p>
            </div>

            <div className="space-y-2 text-right">
              <h3 className="font-bold border-b pb-2">משתתפים ({roomData.players.length}):</h3>
              <div className="grid grid-cols-1 gap-2">
                {roomData.players.map((p: any) => (
                  <div key={p.name} onClick={() => roomData.host === playerName && changePlayerTeam(p.name)} 
                       className="flex justify-between items-center p-3 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100">
                    <span className="font-medium">{p.name} {p.name === playerName && "(אתה)"}</span>
                    <span className={`px-3 py-1 rounded-full text-xs font-bold text-white ${p.team === 0 ? 'bg-blue-500' : p.team === 1 ? 'bg-red-500' : 'bg-green-500'}`}>
                      קבוצה {String.fromCharCode(1488 + p.team)}'
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {roomData.host === playerName && (
              <div className="pt-4 space-y-3 border-t">
                <div className="flex items-center justify-between text-sm">
                  <span>מספר קבוצות:</span>
                  <select value={numTeams} onChange={e => setNumTeams(Number(e.target.value))} className="border rounded px-2 py-1">
                    <option value={2}>2 קבוצות</option>
                    <option value={3}>3 קבוצות</option>
                    <option value={4}>4 קבוצות</option>
                  </select>
                </div>
                <button onClick={shuffleTeams} className="w-full bg-gray-200 py-3 rounded-xl font-bold">ערבב קבוצות 🎲</button>
                <button onClick={startWriting} className="w-full bg-blue-600 text-white py-4 rounded-xl font-black shadow-lg">המשך לכתיבת שמות</button>
              </div>
            )}
          </div>
        )}

        {step === "writing" && (
          <div className="space-y-4">
            <h2 className="text-xl font-bold text-center">הכנס 5 מפורסמים</h2>
            {names.map((n, i) => (
              <input key={i} className="w-full p-3 border rounded-xl" placeholder={`שם ${i+1}`}
                     value={names[i]} onChange={e => {
                       const newNames = [...names];
                       newNames[i] = e.target.value;
                       setNames(newNames);
                     }} />
            ))}
            <button onClick={submitNames} className="w-full bg-green-600 text-white py-4 rounded-xl font-bold">אני מוכן!</button>
          </div>
        )}
      </div>
    </main>
  );
}
