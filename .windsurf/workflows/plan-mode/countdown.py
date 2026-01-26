
import argparse
import sys
import time

DEFAULT_PHASE_SECONDS = {
    1: 8,
    2: 10,
    3: 5,
    4: 5,
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--seconds', type=int, default=None)
    parser.add_argument('--phase', type=int, default=None)
    parser.add_argument('--label', type=str, default='')
    args = parser.parse_args()

    seconds = args.seconds
    if seconds is None:
        if args.phase in DEFAULT_PHASE_SECONDS:
            seconds = DEFAULT_PHASE_SECONDS[args.phase]
        else:
            seconds = 10

    if seconds < 0:
        seconds = 0

    label = (args.label or '').strip()
    if label:
        sys.stdout.write(label + '\n')

    for i in range(seconds, 0, -1):
        sys.stdout.write(f'倒计时 {i}s...\n')
        sys.stdout.flush()
        time.sleep(1)

    sys.stdout.write('倒计时结束。\n')
    sys.stdout.flush()


if __name__ == '__main__':
    main()
