import { useEffect, useMemo, useRef, useState } from "react";
import {
  arrayUnion,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { configReady, db } from "../firebase";

const WHITEBOARD_DOC = "school-main";
const CANVAS_HEIGHT = 420;
const STROKE_COLOR = "#1f3f96";
const STROKE_WIDTH = 3;

function drawPath(ctx, path) {
  if (!path.points || path.points.length === 0) return;
  ctx.strokeStyle = path.color ?? STROKE_COLOR;
  ctx.lineWidth = path.size ?? STROKE_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  path.points.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  });
  ctx.stroke();
}

function getCanvasPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

export default function Whiteboard({
  socket,
  username,
  canDraw,
  initialPaths,
  onExportSnapshot,
}) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [firebasePaths, setFirebasePaths] = useState([]);
  const [activePath, setActivePath] = useState(null);
  const [boardError, setBoardError] = useState("");
  const [canvasWidth, setCanvasWidth] = useState(800);
  const useFirebaseSync = configReady && Boolean(db);
  const visiblePaths = useMemo(
    () => (useFirebaseSync ? firebasePaths : initialPaths ?? []),
    [useFirebaseSync, firebasePaths, initialPaths],
  );

  const boardDoc = useMemo(() => {
    if (!useFirebaseSync) return null;
    return doc(db, "whiteboards", WHITEBOARD_DOC);
  }, [useFirebaseSync]);

  useEffect(() => {
    const onResize = () => {
      if (wrapRef.current) {
        setCanvasWidth(Math.max(300, wrapRef.current.clientWidth - 2));
      }
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!useFirebaseSync || !boardDoc) return;

    setDoc(
      boardDoc,
      { paths: [], updatedAt: serverTimestamp(), updatedBy: "system" },
      { merge: true },
    ).catch(() => {
      setBoardError("Could not initialize whiteboard.");
    });

    const unsub = onSnapshot(
      boardDoc,
      (snapshot) => {
        const data = snapshot.data();
        if (data?.paths && Array.isArray(data.paths)) {
          setFirebasePaths(data.paths);
        }
      },
      () => {
        setBoardError("Whiteboard sync failed. Check Firebase setup.");
      },
    );

    return () => unsub();
  }, [boardDoc, useFirebaseSync]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    visiblePaths.forEach((path) => drawPath(ctx, path));
    if (activePath) {
      drawPath(ctx, activePath);
    }
  }, [visiblePaths, activePath, canvasWidth]);

  const startPath = (event) => {
    if (!canDraw || !canvasRef.current) return;
    const point = getCanvasPoint(event, canvasRef.current);
    setActivePath({
      id: `draft-${Date.now()}`,
      by: username,
      color: STROKE_COLOR,
      size: STROKE_WIDTH,
      points: [point],
      createdAt: new Date().toISOString(),
    });
  };

  const extendPath = (event) => {
    if (!canDraw || !activePath || !canvasRef.current) return;
    const point = getCanvasPoint(event, canvasRef.current);
    setActivePath((prev) => {
      if (!prev) return prev;
      return { ...prev, points: [...prev.points, point] };
    });
  };

  const finishPath = async () => {
    if (!canDraw || !activePath) return;

    const finishedPath = { ...activePath, id: `${Date.now()}-${Math.random()}` };
    setActivePath(null);

    if (useFirebaseSync && boardDoc) {
      try {
        await updateDoc(boardDoc, {
          paths: arrayUnion(finishedPath),
          updatedAt: serverTimestamp(),
          updatedBy: username,
        });
      } catch {
        setBoardError("Could not save whiteboard stroke.");
      }
      return;
    }

    socket.emit("whiteboard_add_path", { path: finishedPath }, (response) => {
      if (!response?.ok) {
        setBoardError(response?.error ?? "Could not save whiteboard stroke.");
      } else {
        setBoardError("");
      }
    });
  };

  const clearWhiteboard = async () => {
    if (!canDraw) return;
    if (useFirebaseSync && boardDoc) {
      try {
        await setDoc(
          boardDoc,
          { paths: [], updatedAt: serverTimestamp(), updatedBy: username },
          { merge: true },
        );
        setBoardError("");
      } catch {
        setBoardError("Could not clear whiteboard.");
      }
      return;
    }

    socket.emit("whiteboard_clear", {}, (response) => {
      if (!response?.ok) {
        setBoardError(response?.error ?? "Could not clear whiteboard.");
      } else {
        setBoardError("");
      }
    });
  };

  const exportSnapshot = () => {
    if (!canvasRef.current || !onExportSnapshot) return;
    canvasRef.current.toBlob(
      (blob) => {
        if (!blob) {
          setBoardError("Could not create whiteboard snapshot.");
          return;
        }
        const file = new File(
          [blob],
          `whiteboard-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
          { type: "image/png" },
        );
        onExportSnapshot(file);
      },
      "image/png",
      0.95,
    );
  };

  return (
    <section className="whiteboardPanel">
      <div className="boardHeader">
        <p className="roomHint">
          {canDraw
            ? "Moderator mode: draw live notes for the class."
            : "View mode: live board updates from moderators."}
        </p>
        <div className="boardButtons">
          {canDraw ? (
            <button className="secondary" onClick={exportSnapshot}>
              Send Snapshot To Chat
            </button>
          ) : null}
          {canDraw ? (
            <button className="danger" onClick={clearWhiteboard}>
              Clear Board
            </button>
          ) : null}
        </div>
      </div>

      {!useFirebaseSync ? (
        <p className="roomHint fallbackHint">
          Running in socket mode (works now). Add Firebase keys later for
          cloud-synced whiteboard.
        </p>
      ) : null}

      <div className="boardCanvasWrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          width={canvasWidth}
          height={CANVAS_HEIGHT}
          className={`boardCanvas ${canDraw ? "canDraw" : "readOnly"}`}
          onPointerDown={startPath}
          onPointerMove={extendPath}
          onPointerUp={finishPath}
          onPointerLeave={finishPath}
        />
      </div>

      {boardError ? <p className="chatError">{boardError}</p> : null}
    </section>
  );
}
