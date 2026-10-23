import idleImage from './assets/gpt/idle.webp';
import blinkImage from './assets/gpt/idle-blink.webp';
import thinkingImage from './assets/gpt/thinking.webp';
import happyImage from './assets/gpt/happy.webp';
import reminderImage from './assets/gpt/running.webp';

export type PetState = 'idle' | 'thinking' | 'reminder' | 'happy';

const artwork: Record<PetState, string> = {
  idle: idleImage,
  thinking: thinkingImage,
  reminder: reminderImage,
  happy: happyImage,
};

const descriptions: Record<PetState, string> = {
  idle: '慢慢，陪你安排生活的 GPT 白龙娘',
  thinking: '慢慢正在想你的安排',
  reminder: '慢慢来提醒你了',
  happy: '慢慢为你完成一件事而开心',
};

/** The original transparent GPT dragon artwork is bundled with the app. */
export function Pet({ className = '', compact = false, state = 'idle' }: {
  className?: string;
  compact?: boolean;
  state?: PetState;
}) {
  return (
    <span
      className={`momo-pet momo-pet--${state} ${compact ? 'is-compact' : ''} ${className}`.trim()}
      role="img"
      aria-label={descriptions[state]}
      data-state={state}
    >
      <span className="momo-artwork" aria-hidden="true">
        <img className="momo-image" src={artwork[state]} alt="" draggable={false} />
        {state === 'idle' && <img className="momo-image momo-blink" src={blinkImage} alt="" draggable={false} />}
      </span>
    </span>
  );
}
