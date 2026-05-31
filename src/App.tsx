import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Activity,
  AlertTriangle,
  Camera,
  CheckCircle,
  Clock,
  Download,
  Eye,
  Film,
  Server,
  Square,
  Video,
  X,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  PointElement,
  LineElement,
} from 'chart.js';
import { Bar, Line } from 'react-chartjs-2';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  PointElement,
  LineElement
);

// Configuration constants (matching backend)
const NUM_FRAMES_PER_INFERENCE = 3;
const FRAME_SKIP = 5; // Capture 1 frame every 5 video frames
const JPEG_QUALITY = 80;
const API_BASE_URL = 'http://localhost:5000';

const ACTION_CLASSES = [
  'back pain', 'blow nose', 'chest pain', 'falling down', 'fan self',
  'headache', 'nausea/vomiting', 'neck pain', 'okay', 'sneeze/cough',
  'staggering', 'stretch oneself', 'yawn'
] as const;

type ActionClass = typeof ACTION_CLASSES[number];

const DISTRESS_CLASSES = [
  'back pain', 'chest pain', 'falling down', 'headache',
  'nausea/vomiting', 'neck pain', 'staggering'
];

const NEUTRAL_CLASSES = ['blow nose', 'fan self', 'sneeze/cough', 'stretch oneself', 'yawn'];

// Session log entry type
interface LogEntry {
  id: number;
  classification: string;
  timestamp: string;
  mode: 'stream' | 'record';
}

export default function App() {
  // State
  const [mode, setMode] = useState<'idle' | 'stream' | 'recording'>('idle');
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentClassification, setCurrentClassification] = useState<string | null>(null);
  const [sessionLog, setSessionLog] = useState<LogEntry[]>([]);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [recordingTime, setRecordingTime] = useState(0);
  const [apiStatus, setApiStatus] = useState<'connected' | 'disconnected' | 'checking'>('checking');
  const [showReportModal, setShowReportModal] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const sessionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Frame capture refs - use refs to avoid closure issues
  const modeRef = useRef<'idle' | 'stream' | 'recording'>('idle');
  const frameCountRef = useRef(0);
  const capturedFramesRef = useRef<string[]>([]);
  const animationFrameRef = useRef<number | null>(null);
  const isProcessingRef = useRef(false);

  // Keep modeRef in sync with mode state
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // Check API health on mount
  useEffect(() => {
    checkApiHealth();
    const interval = setInterval(checkApiHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  const checkApiHealth = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/health`);
      const data = await response.json();
      setApiStatus(data.status === 'healthy' ? 'connected' : 'disconnected');
    } catch {
      setApiStatus('disconnected');
    }
  };

  // Session timer
  useEffect(() => {
    if (mode === 'stream' || mode === 'recording') {
      sessionTimerRef.current = setInterval(() => {
        setElapsedTime(prev => prev + 1);
      }, 1000);
    } else {
      if (sessionTimerRef.current) {
        clearInterval(sessionTimerRef.current);
      }
    }
    return () => {
      if (sessionTimerRef.current) {
        clearInterval(sessionTimerRef.current);
      }
    };
  }, [mode]);

  // Recording timer
  useEffect(() => {
    if (mode === 'recording') {
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } else {
      setRecordingTime(0);
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
    }
    return () => {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
    };
  }, [mode]);

  // Capture frame from video
  const captureFrame = useCallback((): string | null => {
    if (!videoRef.current || !canvasRef.current) return null;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    if (!ctx || video.videoWidth === 0 || video.videoHeight === 0) return null;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    return canvas.toDataURL('image/jpeg', JPEG_QUALITY / 100).split(',')[1];
  }, []);

  // Send frames to API for classification
  const sendFramesForClassification = async (frames: string[]) => {
    if (frames.length < NUM_FRAMES_PER_INFERENCE) return;

    setIsProcessing(true);
    isProcessingRef.current = true;

    try {
      // Take only the required number of frames
      const framesToSend = frames.slice(0, NUM_FRAMES_PER_INFERENCE);

      const response = await fetch(`${API_BASE_URL}/api/classify-frames`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frames: framesToSend })
      });

      if (!response.ok) {
        throw new Error('API request failed');
      }

      const data = await response.json();
      handleClassificationResult(data.classification, data.timestamp, 'stream');

    } catch (error) {
      console.error('Classification error:', error);
      showToast('Classification failed - retrying...');
    } finally {
      setIsProcessing(false);
      isProcessingRef.current = false;
    }
  };

  // Frame capture loop using requestAnimationFrame
  const frameCaptureLoop = useCallback(() => {
    // Only capture if in stream mode
    if (modeRef.current !== 'stream') {
      animationFrameRef.current = null;
      return;
    }

    frameCountRef.current++;

    // Every FRAME_SKIP frames, capture one frame
    if (frameCountRef.current % FRAME_SKIP === 0) {
      const frame = captureFrame();
      if (frame) {
        capturedFramesRef.current.push(frame);

        // When we have enough frames, send for classification
        if (capturedFramesRef.current.length >= NUM_FRAMES_PER_INFERENCE && !isProcessingRef.current) {
          const framesToProcess = [...capturedFramesRef.current];
          capturedFramesRef.current = [];
          sendFramesForClassification(framesToProcess);
        }
      }
    }

    // Continue the loop
    animationFrameRef.current = requestAnimationFrame(frameCaptureLoop);
  }, [captureFrame]);

  // Start stream mode
  const startStreamMode = async () => {
    await startWebcam();

    // Reset frame tracking
    frameCountRef.current = 0;
    capturedFramesRef.current = [];
    isProcessingRef.current = false;

    setMode('stream');
    modeRef.current = 'stream';

    // Wait for video to be ready
    await new Promise(resolve => setTimeout(resolve, 300));

    // Start frame capture loop
    animationFrameRef.current = requestAnimationFrame(frameCaptureLoop);
  };

  // Stop stream mode
  const stopStreamMode = () => {
    // Stop frame capture loop
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    stopWebcam();
    setMode('idle');
    modeRef.current = 'idle';
    setIsProcessing(false);
    isProcessingRef.current = false;

    // Clear captured frames
    capturedFramesRef.current = [];
    frameCountRef.current = 0;
  };

  // Start webcam
  const startWebcam = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, frameRate: 30 },
        audio: false
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch (error) {
      console.error('Error accessing webcam:', error);
      showToast('Could not access webcam');
    }
  };

  // Stop webcam
  const stopWebcam = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  // Start recording mode
  const startRecordingMode = async () => {
    await startWebcam();
    recordedChunksRef.current = [];

    // Wait for camera to initialize
    await new Promise(resolve => setTimeout(resolve, 500));

    // Start MediaRecorder
    if (streamRef.current) {
      // Check supported mime types
      let mimeType = 'video/webm;codecs=vp9';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'video/webm;codecs=vp8';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = 'video/webm';
        }
      }

      const mediaRecorder = new MediaRecorder(streamRef.current, { mimeType });

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(100); // Collect data every 100ms

      setMode('recording');
      modeRef.current = 'recording';
    }
  };

  // Stop recording mode
  const stopRecordingMode = async () => {
    const recorder = mediaRecorderRef.current;

    if (recorder && recorder.state !== 'inactive') {
      setIsProcessing(true);

      return new Promise<void>((resolve) => {
        recorder.onstop = async () => {
          await processRecordedVideo();
          setIsProcessing(false);
          resolve();
        };
        recorder.stop();
      });
    }

    stopWebcam();
    setMode('idle');
    modeRef.current = 'idle';
  };

  // Process recorded video
  const processRecordedVideo = async () => {
    try {
      if (recordedChunksRef.current.length === 0) {
        showToast('No video data recorded');
        return;
      }

      const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });

      // Convert to base64
      const base64Video = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          resolve(result);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      // Send to API
      const response = await fetch(`${API_BASE_URL}/api/classify-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video: base64Video })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'API request failed');
      }

      const data = await response.json();
      handleClassificationResult(data.classification, data.timestamp, 'record');

    } catch (error) {
      console.error('Video classification error:', error);
      showToast('Video classification failed');
    } finally {
      stopWebcam();
      setMode('idle');
      modeRef.current = 'idle';
    }
  };

  // Handle classification result
  const handleClassificationResult = (classification: string, timestamp: string, modeType: 'stream' | 'record') => {
    setCurrentClassification(classification);

    const entry: LogEntry = {
      id: Date.now(),
      classification,
      timestamp,
      mode: modeType
    };

    setSessionLog(prev => [entry, ...prev].slice(0, 20));
  };

  // Show toast notification
  const showToast = (message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(null), 3000);
  };

  // Export CSV
  const exportCSV = () => {
    const headers = ['#', 'Timestamp', 'Mode', 'Classification'];
    const rows = sessionLog.map((entry, index) => [
      sessionLog.length - index,
      entry.timestamp,
      entry.mode,
      entry.classification
    ]);

    const csvContent = [headers, ...rows]
      .map(row => row.join(','))
      .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mediscan_session_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Format time
  const formatTime = (seconds: number): string => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Format timestamp for display
  const formatTimestamp = (iso: string): string => {
    const date = new Date(iso);
    return date.toLocaleTimeString('en-US', { hour12: false });
  };

  // Get classification color class
  const getClassColor = (classification: string): string => {
    if (classification === 'okay') return 'text-green-400';
    if (DISTRESS_CLASSES.includes(classification)) return 'text-red-500 animate-pulse';
    return 'text-cyan-400';
  };

  // Get classification badge color
  const getBadgeColor = (classification: string): string => {
    if (classification === 'okay') return 'bg-green-500/20 border-green-500 text-green-400';
    if (DISTRESS_CLASSES.includes(classification)) return 'bg-red-500/20 border-red-500 text-red-400';
    return 'bg-cyan-500/20 border-cyan-500 text-cyan-400';
  };

  // Chart data computations
  const actionFrequency = sessionLog.reduce((acc, entry) => {
    acc[entry.classification] = (acc[entry.classification] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const distressCount = sessionLog.filter(e => DISTRESS_CLASSES.includes(e.classification)).length;

  // Chart colors
  const getBarColor = (action: string): string => {
    if (action === 'okay') return 'rgb(57, 255, 20)';
    if (DISTRESS_CLASSES.includes(action)) return 'rgb(239, 68, 68)';
    return 'rgb(0, 245, 255)';
  };

  const barChartData = {
    labels: ACTION_CLASSES,
    datasets: [{
      label: 'Frequency',
      data: ACTION_CLASSES.map(action => actionFrequency[action] || 0),
      backgroundColor: ACTION_CLASSES.map(action => getBarColor(action)),
      borderColor: ACTION_CLASSES.map(action => getBarColor(action)),
      borderWidth: 1,
    }]
  };

  // Timeline chart - last 30 data points
  const actionToIndex = (action: string): number => ACTION_CLASSES.indexOf(action as ActionClass);
  const recentLog = sessionLog.slice(0, 30).reverse();

  const timelineData = {
    labels: recentLog.map(e => formatTimestamp(e.timestamp)),
    datasets: [{
      label: 'Action Index',
      data: recentLog.map(e => actionToIndex(e.classification)),
      borderColor: 'rgb(0, 245, 255)',
      backgroundColor: 'rgba(0, 245, 255, 0.1)',
      tension: 0.3,
      pointRadius: 4,
      pointHoverRadius: 6,
    }]
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
    },
    scales: {
      y: {
        ticks: { color: 'rgba(255, 255, 255, 0.6)' },
        grid: { color: 'rgba(255, 255, 255, 0.1)' },
      },
      x: {
        ticks: { color: 'rgba(255, 255, 255, 0.6)', maxRotation: 45 },
        grid: { color: 'rgba(255, 255, 255, 0.1)' },
      }
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0e1a] text-white overflow-hidden relative">
      {/* CSS Grid Background */}
      <div className="fixed inset-0 pointer-events-none opacity-10">
        <div className="absolute inset-0" style={{
          backgroundImage: `
            linear-gradient(rgba(0, 245, 255, 0.1) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0, 245, 255, 0.1) 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px'
        }} />
      </div>

      {/* Scanline Effect */}
      <div className="fixed inset-0 pointer-events-none opacity-5">
        <div className="h-full w-full" style={{
          backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0, 245, 255, 0.03) 2px, rgba(0, 245, 255, 0.03) 4px)'
        }} />
      </div>

      {/* Header */}
      <header className="relative border-b border-cyan-500/30 bg-[#0d1225]/90 backdrop-blur-sm px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Activity className="w-8 h-8 text-cyan-400 animate-pulse" />
            <h1 className="text-2xl font-bold tracking-wider" style={{ fontFamily: 'Orbitron' }}>
              MediScan AI Monitor
            </h1>
          </div>

          <div className="flex items-center gap-6">
            {/* Session Timer */}
            <div className="flex items-center gap-2 bg-[#111827] px-4 py-2 rounded-lg border border-cyan-500/30">
              <Clock className="w-5 h-5 text-cyan-400" />
              <span className="font-mono text-lg" style={{ fontFamily: 'Share Tech Mono' }}>
                {formatTime(elapsedTime)}
              </span>
            </div>

            {/* API Status */}
            <div className="flex items-center gap-2">
              <div className={`w-3 h-3 rounded-full ${
                apiStatus === 'connected' ? 'bg-green-400 animate-pulse' :
                apiStatus === 'checking' ? 'bg-yellow-400 animate-pulse' : 'bg-red-500'
              }`} />
              <span className="text-sm text-gray-400">
                {apiStatus === 'connected' ? 'Connected' : apiStatus === 'checking' ? 'Checking...' : 'Disconnected'}
              </span>
              {apiStatus === 'connected' ? <Wifi className="w-4 h-4 text-green-400" /> : <WifiOff className="w-4 h-4 text-red-400" />}
            </div>
          </div>
        </div>
      </header>

      {/* Control Panel */}
      <div className="relative py-6 px-6 bg-[#0d1225]/50 border-b border-cyan-500/20">
        <div className="max-w-7xl mx-auto flex items-center justify-center gap-8">
          {/* Stream Button */}
          <button
            onClick={mode === 'stream' ? stopStreamMode : startStreamMode}
            disabled={mode === 'recording'}
            className={`
              relative px-8 py-4 rounded-lg font-bold text-lg tracking-wide
              transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed
              ${mode === 'stream'
                ? 'bg-cyan-500/20 border-2 border-cyan-400 text-cyan-400 shadow-[0_0_20px_rgba(0,245,255,0.4)]'
                : 'bg-[#111827] border border-cyan-500/50 hover:border-cyan-400 hover:bg-cyan-500/10 text-cyan-300'}
            `}
            style={{ fontFamily: 'Orbitron' }}
          >
            {mode === 'stream' && (
              <div className="absolute inset-0 rounded-lg animate-ping opacity-20 bg-cyan-400" />
            )}
            <div className="relative flex items-center gap-3">
              <Camera className="w-6 h-6" />
              {mode === 'stream' ? 'STOP STREAM' : 'STREAM'}
            </div>
          </button>

          {/* Record Button */}
          <button
            onClick={mode === 'recording' ? stopRecordingMode : startRecordingMode}
            disabled={mode === 'stream'}
            className={`
              relative px-8 py-4 rounded-lg font-bold text-lg tracking-wide
              transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed
              ${mode === 'recording'
                ? 'bg-red-500/20 border-2 border-red-500 text-red-400 shadow-[0_0_20px_rgba(239,68,68,0.4)]'
                : 'bg-[#111827] border border-red-500/50 hover:border-red-400 hover:bg-red-500/10 text-red-300'}
            `}
            style={{ fontFamily: 'Orbitron' }}
          >
            {mode === 'recording' && (
              <div className="absolute inset-0 rounded-lg animate-pulse opacity-30 bg-red-500" />
            )}
            <div className="relative flex items-center gap-3">
              {mode === 'recording' ? <Square className="w-6 h-6" /> : <Video className="w-6 h-6" />}
              {mode === 'recording' ? 'STOP' : 'RECORD'}
            </div>
          </button>

          {/* View Report Button */}
          <button
            onClick={() => setShowReportModal(true)}
            className="px-6 py-4 rounded-lg font-bold tracking-wide
              bg-[#111827] border border-gray-500/50 hover:border-gray-400
              hover:bg-gray-500/10 text-gray-300 transition-all duration-300"
            style={{ fontFamily: 'Orbitron' }}
          >
            <div className="flex items-center gap-3">
              <Eye className="w-6 h-6" />
              VIEW REPORT
            </div>
          </button>
        </div>
      </div>

      {/* Main Content */}
      <main className="relative max-w-7xl mx-auto px-6 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Video Feed */}
          <div className="relative">
            <div className="bg-[#0d1225] rounded-lg border border-cyan-500/30 overflow-hidden"
              style={{ boxShadow: '0 0 30px rgba(0, 245, 255, 0.1)' }}>
              {/* Video Element */}
              <div className="relative aspect-video bg-black">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />

                {/* Grid Overlay */}
                <div className="absolute inset-0 pointer-events-none border-2 border-cyan-500/30"
                  style={{
                    boxShadow: 'inset 0 0 50px rgba(0, 245, 255, 0.1)'
                  }} />

                {/* Classification Overlay */}
                {currentClassification && (
                  <div className="absolute top-4 right-4">
                    <div className={`px-4 py-2 rounded-lg border backdrop-blur-sm ${getBadgeColor(currentClassification)}`}
                      style={{ fontFamily: 'Orbitron' }}>
                      <span className="text-xl font-bold uppercase">
                        {currentClassification}
                      </span>
                    </div>
                  </div>
                )}

                {/* Recording Badge */}
                {mode === 'recording' && (
                  <div className="absolute top-4 left-4 flex items-center gap-2 bg-red-500/20 border border-red-500 px-4 py-2 rounded-lg backdrop-blur-sm">
                    <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
                    <span className="font-bold text-red-400" style={{ fontFamily: 'Orbitron' }}>REC {formatTime(recordingTime)}</span>
                  </div>
                )}

                {/* Processing Overlay */}
                {isProcessing && mode !== 'recording' && (
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center backdrop-blur-sm">
                    <div className="flex items-center gap-4 text-cyan-400">
                      <div className="w-8 h-8 border-4 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
                      <span className="font-bold text-xl" style={{ fontFamily: 'Orbitron' }}>ANALYZING...</span>
                    </div>
                  </div>
                )}

                {/* Idle State */}
                {mode === 'idle' && !currentClassification && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="text-center">
                      <Camera className="w-16 h-16 text-cyan-500/30 mx-auto mb-4" />
                      <p className="text-gray-500">Click STREAM or RECORD to begin</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Hidden Canvas for Frame Capture */}
            <canvas ref={canvasRef} className="hidden" />
          </div>

          {/* Classification Feed */}
          <div className="bg-[#0d1225] rounded-lg border border-cyan-500/30 overflow-hidden"
            style={{ boxShadow: '0 0 30px rgba(0, 245, 255, 0.1)' }}>
            <div className="px-4 py-3 border-b border-cyan-500/30 bg-[#111827]/50">
              <h2 className="font-bold text-lg flex items-center gap-2" style={{ fontFamily: 'Orbitron' }}>
                <Activity className="w-5 h-5 text-cyan-400" />
                Live Classification Feed
              </h2>
            </div>

            <div className="h-[400px] overflow-y-auto p-4 space-y-3">
              {sessionLog.length === 0 ? (
                <div className="h-full flex items-center justify-center text-gray-500">
                  <p>No classifications yet</p>
                </div>
              ) : (
                sessionLog.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-[#111827]/50 border border-cyan-500/20"
                  >
                    <div className="flex items-center gap-4">
                      <span className="text-gray-500 font-mono text-sm">
                        {formatTimestamp(entry.timestamp)}
                      </span>
                      <span className={`px-3 py-1 rounded border text-sm ${getBadgeColor(entry.classification)}`}>
                        {entry.classification.toUpperCase()}
                      </span>
                      <span className="text-xs text-gray-500 uppercase px-2 py-1 bg-gray-800 rounded">
                        {entry.mode}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Analytics Panel */}
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Action Frequency Chart */}
          <div className="lg:col-span-2 bg-[#0d1225] rounded-lg border border-cyan-500/30 p-4"
            style={{ boxShadow: '0 0 30px rgba(0, 245, 255, 0.1)' }}>
            <h3 className="font-bold mb-4 flex items-center gap-2" style={{ fontFamily: 'Orbitron' }}>
              <Server className="w-5 h-5 text-cyan-400" />
              Action Frequency
            </h3>
            <div className="h-64">
              <Bar data={barChartData} options={chartOptions} />
            </div>
          </div>

          {/* Distress Counter */}
          <div className={`bg-[#0d1225] rounded-lg border p-6 flex flex-col items-center justify-center
            ${distressCount > 0 ? 'border-red-500 shadow-[0_0_30px_rgba(239,68,68,0.3)]' : 'border-cyan-500/30'}`}
            style={{ boxShadow: distressCount > 0 ? '0 0 30px rgba(239, 68, 68, 0.2)' : '0 0 30px rgba(0, 245, 255, 0.1)' }}>
            <AlertTriangle className={`w-12 h-12 mb-4 ${distressCount > 0 ? 'text-red-400 animate-pulse' : 'text-gray-600'}`} />
            <h3 className="font-bold mb-2 text-gray-400" style={{ fontFamily: 'Orbitron' }}>DISTRESS ALERTS</h3>
            <div className={`text-6xl font-bold ${distressCount > 0 ? 'text-red-400' : 'text-gray-600'}`}
              style={{ fontFamily: 'Orbitron' }}>
              {distressCount}
            </div>
            <p className="text-sm text-gray-500 mt-2">Total distress classifications</p>
          </div>
        </div>

        {/* Timeline Chart */}
        <div className="mt-6 bg-[#0d1225] rounded-lg border border-cyan-500/30 p-4"
          style={{ boxShadow: '0 0 30px rgba(0, 245, 255, 0.1)' }}>
          <h3 className="font-bold mb-4 flex items-center gap-2" style={{ fontFamily: 'Orbitron' }}>
            <Clock className="w-5 h-5 text-cyan-400" />
            Classification Timeline
          </h3>
          <div className="h-48">
            <Line data={timelineData} options={chartOptions} />
          </div>
        </div>
      </main>

      {/* Session Report Modal */}
      {showReportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="w-full max-w-4xl max-h-[90vh] bg-[#0d1225] rounded-lg border border-cyan-500/30 overflow-hidden"
            style={{ boxShadow: '0 0 50px rgba(0, 245, 255, 0.2)' }}>
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-cyan-500/30 bg-[#111827]/50 flex items-center justify-between">
              <h2 className="text-xl font-bold flex items-center gap-3" style={{ fontFamily: 'Orbitron' }}>
                <Film className="w-6 h-6 text-cyan-400" />
                Session Report
              </h2>
              <button
                onClick={() => setShowReportModal(false)}
                className="p-2 hover:bg-gray-700/50 rounded-lg transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 overflow-y-auto max-h-[calc(90vh-140px)]">
              {sessionLog.length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                  <CheckCircle className="w-16 h-16 mx-auto mb-4 opacity-30" />
                  <p>No data recorded yet</p>
                </div>
              ) : (
                <>
                  {/* Summary Stats */}
                  <div className="grid grid-cols-3 gap-4 mb-6">
                    <div className="bg-[#111827] p-4 rounded-lg border border-cyan-500/20">
                      <p className="text-gray-500 text-sm mb-1">Total Classifications</p>
                      <p className="text-2xl font-bold text-cyan-400" style={{ fontFamily: 'Orbitron' }}>
                        {sessionLog.length}
                      </p>
                    </div>
                    <div className="bg-[#111827] p-4 rounded-lg border border-red-500/20">
                      <p className="text-gray-500 text-sm mb-1">Distress Events</p>
                      <p className="text-2xl font-bold text-red-400" style={{ fontFamily: 'Orbitron' }}>
                        {distressCount}
                      </p>
                    </div>
                    <div className="bg-[#111827] p-4 rounded-lg border border-green-500/20">
                      <p className="text-gray-500 text-sm mb-1">Okay Events</p>
                      <p className="text-2xl font-bold text-green-400" style={{ fontFamily: 'Orbitron' }}>
                        {sessionLog.filter(e => e.classification === 'okay').length}
                      </p>
                    </div>
                  </div>

                  {/* Data Table */}
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-cyan-500/30">
                        <th className="px-4 py-3 text-left text-gray-400 font-bold">#</th>
                        <th className="px-4 py-3 text-left text-gray-400 font-bold">Timestamp</th>
                        <th className="px-4 py-3 text-left text-gray-400 font-bold">Mode</th>
                        <th className="px-4 py-3 text-left text-gray-400 font-bold">Classification</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessionLog.map((entry, index) => (
                        <tr key={entry.id} className="border-b border-cyan-500/10 hover:bg-[#111827]/50">
                          <td className="px-4 py-3 text-gray-500">{sessionLog.length - index}</td>
                          <td className="px-4 py-3 font-mono text-sm">{entry.timestamp}</td>
                          <td className="px-4 py-3">
                            <span className="text-xs uppercase px-2 py-1 bg-gray-800 rounded">
                              {entry.mode}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`px-3 py-1 rounded border text-sm ${getBadgeColor(entry.classification)}`}>
                              {entry.classification.toUpperCase()}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-cyan-500/30 bg-[#111827]/50 flex justify-end gap-4">
              <button
                onClick={exportCSV}
                disabled={sessionLog.length === 0}
                className="flex items-center gap-2 px-4 py-2 bg-green-500/20 border border-green-500
                  hover:bg-green-500/30 rounded-lg text-green-400 font-bold transition-colors
                  disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Download className="w-5 h-5" />
                EXPORT CSV
              </button>
              <button
                onClick={() => setShowReportModal(false)}
                className="flex items-center gap-2 px-4 py-2 bg-gray-700/50 border border-gray-500
                  hover:bg-gray-700 rounded-lg text-gray-300 font-bold transition-colors"
              >
                CLOSE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 px-6 py-3 bg-red-500/90 border border-red-400 rounded-lg
          text-white font-bold shadow-lg" style={{ fontFamily: 'Orbitron' }}>
          {toastMessage}
        </div>
      )}

      {/* Global Styles */}
      <style>{`
        body {
          font-family: 'Share Tech Mono', monospace;
        }
      `}</style>
    </div>
  );
}
