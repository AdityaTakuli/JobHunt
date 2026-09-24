import { animate, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';

// Types `text` one character at a time with a blinking caret, then calls onDone. Screen readers
// get the full text at once; the untyped rest is kept (invisible) so the layout never jumps.
export default function Typewriter({ text, as: Tag = 'span', className, speed = 45, delay = 0, caret = true, onDone }) {
  const reduce = useReducedMotion();
  const [count, setCount] = useState(reduce ? text.length : 0);
  const [done, setDone] = useState(reduce);

  useEffect(() => {
    if (reduce) {
      setCount(text.length);
      onDone?.();
      return undefined;
    }
    setCount(0);
    setDone(false);
    const controls = animate(0, text.length, {
      duration: (text.length * speed) / 1000,
      delay: delay / 1000,
      ease: 'linear',
      onUpdate: (v) => setCount(Math.round(v)),
      onComplete: () => {
        setDone(true);
        onDone?.();
      },
    });
    return () => controls.stop();
    // onDone is intentionally not a dependency: a new callback must not restart the typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, speed, delay, reduce]);

  return (
    <Tag className={className}>
      <span className="visually-hidden">{text}</span>
      <span aria-hidden="true">
        {text.slice(0, count)}
        {caret && (
          <motion.span
            className="caret"
            animate={done ? { opacity: [1, 0, 1] } : { opacity: 1 }}
            transition={done ? { duration: 1, repeat: Infinity, times: [0, 0.5, 1] } : undefined}
          />
        )}
        <span className="typewriter-rest">{text.slice(count)}</span>
      </span>
    </Tag>
  );
}
