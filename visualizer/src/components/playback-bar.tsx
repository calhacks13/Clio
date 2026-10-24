import React from "react";
import { useTime } from "../context/time-context";
import { LuPlay, LuPause, LuRotateCcw } from "react-icons/lu";

const PlaybackBar: React.FC = () => {
  const { duration, isPlaying, setIsPlaying, currentTime, seek } = useTime();

  const sliderActiveRef = React.useRef(false);
  const wasPlayingRef = React.useRef(false);
  const sliderValueRef = React.useRef(currentTime);
  const [sliderValue, setSliderValue] = React.useState(currentTime);

  // Only update sliderValue from context if not dragging
  React.useEffect(() => {
    if (!sliderActiveRef.current) {
      sliderValueRef.current = currentTime;
      setSliderValue(currentTime);
    }
  }, [currentTime]);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = Number(e.target.value);
    sliderValueRef.current = t;
    setSliderValue(t);
    // Seek videos immediately while dragging (no debounce)
    seek(t);
  };

  const handleSliderMouseDown = () => {
    sliderActiveRef.current = true;
    wasPlayingRef.current = isPlaying;
    setIsPlaying(false);
  };

  const handleSliderMouseUp = () => {
    sliderActiveRef.current = false;
    // Final seek to exact slider position
    seek(sliderValueRef.current);
    if (wasPlayingRef.current) {
      setIsPlaying(true);
    }
  };

  return (
    <div className="replay-transport sticky bottom-0 mt-auto w-full">
      <div className="transport-controls">
        <button
          className="transport-play"
          aria-label={isPlaying ? "Pause recording" : "Play recording"}
          title={isPlaying ? "Pause (Space)" : "Play (Space)"}
          onClick={() => setIsPlaying(!isPlaying)}
        >
          {isPlaying ? (
            <LuPause size={17} fill="currentColor" aria-hidden="true" />
          ) : (
            <LuPlay size={17} fill="currentColor" aria-hidden="true" />
          )}
        </button>
        <button
          title="Rewind to start"
          aria-label="Rewind to start"
          onClick={() => seek(0)}
          className="btn"
        >
          <LuRotateCcw size={16} aria-hidden="true" />
          <span className="hidden sm:inline">Restart</span>
        </button>
        <input
          type="range"
          min={0}
          max={duration}
          step={0.01}
          value={sliderValue}
          onChange={handleSliderChange}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            handleSliderMouseDown();
          }}
          onPointerUp={handleSliderMouseUp}
          onPointerCancel={handleSliderMouseUp}
          onLostPointerCapture={() => {
            if (sliderActiveRef.current) handleSliderMouseUp();
          }}
          className="transport-scrubber"
          aria-label="Seek recording"
          aria-valuetext={`${Math.round(sliderValue)} seconds`}
        />
        <span className="transport-time tabular">
          <strong>{Math.round(sliderValue)}</strong>
          <span>/</span>
          {Math.round(duration)} s
        </span>
      </div>
    </div>
  );
};

export default PlaybackBar;
