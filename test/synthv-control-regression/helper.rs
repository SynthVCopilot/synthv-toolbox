use std::io::Read;

fn main() {
    let mut stdin = std::io::stdin();
    let mut buffer = [0_u8; 64];
    while stdin.read(&mut buffer).unwrap_or(0) != 0 {}
}
