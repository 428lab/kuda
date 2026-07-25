//! ブロックの行き先を決める。
//!
//! 同じ32Bブロックを /dev/random と kuda の両方に流すと、カーネル乱数の種を
//! 公開プールに出すことになる。そこで宛先は必ずどちらか一方にする。
//!
//! 配分は乱数ではなく累積誤差法で決める。kernel_share を足し込み、1.0 を超えた
//! ところでカーネルに1個回す。指定した比率に長期的にも短期的にも素直に収束し、
//! 「今どちらに行ったか」が再現可能になる。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Destination {
    Kernel,
    Pipe,
}

pub struct Router {
    share: f64,
    acc: f64,
}

impl Router {
    pub fn new(kernel_share: f64) -> Self {
        Router {
            share: kernel_share,
            acc: 0.0,
        }
    }

    pub fn route(&mut self) -> Destination {
        self.acc += self.share;
        if self.acc >= 1.0 {
            self.acc -= 1.0;
            Destination::Kernel
        } else {
            Destination::Pipe
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn take(share: f64, n: usize) -> Vec<Destination> {
        let mut r = Router::new(share);
        (0..n).map(|_| r.route()).collect()
    }

    #[test]
    fn all_to_kernel_when_share_is_one() {
        assert!(take(1.0, 10).iter().all(|d| *d == Destination::Kernel));
    }

    #[test]
    fn all_to_pipe_when_share_is_zero() {
        assert!(take(0.0, 10).iter().all(|d| *d == Destination::Pipe));
    }

    #[test]
    fn alternates_at_half() {
        assert_eq!(
            take(0.5, 4),
            vec![
                Destination::Pipe,
                Destination::Kernel,
                Destination::Pipe,
                Destination::Kernel
            ]
        );
    }

    #[test]
    fn one_in_four_at_quarter() {
        let got = take(0.25, 8);
        let kernel = got.iter().filter(|d| **d == Destination::Kernel).count();
        assert_eq!(kernel, 2);
    }

    #[test]
    fn keeps_ratio_over_many_blocks() {
        let got = take(0.3, 1000);
        let kernel = got.iter().filter(|d| **d == Destination::Kernel).count();
        // 累積誤差法なので端数1個のずれしか出ない
        assert!((299..=300).contains(&kernel), "kernel={kernel}");
    }
}
