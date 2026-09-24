//! Bounded raw-unit accounting shared by future batch settlement paths.
use anchor_lang::prelude::*;

pub const MAX_AMOUNT: u64 = 1_000_000_000_000;
pub const MAX_POOL_AMOUNT: u64 = 3 * MAX_AMOUNT;

pub use crate::CrossflowError as MathError;

pub fn checked_add_amount(a: u64, b: u64) -> Result<u64> {
    require!(a <= MAX_POOL_AMOUNT && b <= MAX_POOL_AMOUNT, MathError::Amount);
    let result = a.checked_add(b).ok_or(MathError::MathArithmetic)?;
    require!(result <= MAX_POOL_AMOUNT, MathError::Amount);
    Ok(result)
}

/// Allocate actual external output by exact input weights. Remainders break ties by
/// ascending owner bytes, never by caller account order. Zero-input owners get zero.
pub fn largest_remainder_three(output: u64, inputs: [u64; 3], owners: [Pubkey; 3]) -> Result<[u64; 3]> {
    require!(output <= MAX_POOL_AMOUNT && inputs.iter().all(|x| *x <= MAX_AMOUNT), MathError::Amount);
    for i in 0..3 {
        for j in i + 1..3 {
            require!(owners[i] != owners[j], MathError::DuplicateOwner);
        }
    }
    let total = inputs.iter().try_fold(0u64, |sum, input| checked_add_amount(sum, *input))?;
    if total == 0 {
        require!(output == 0, MathError::MathArithmetic);
        return Ok([0; 3]);
    }
    let mut allocated = [0u64; 3];
    let mut residues = [0u128; 3];
    let mut base_sum = 0u64;
    for i in 0..3 {
        if inputs[i] == 0 { continue; }
        let numerator = (output as u128).checked_mul(inputs[i] as u128).ok_or(MathError::MathArithmetic)?;
        allocated[i] = u64::try_from(numerator / total as u128).map_err(|_| MathError::MathArithmetic)?;
        residues[i] = numerator % total as u128;
        base_sum = checked_add_amount(base_sum, allocated[i])?;
    }
    let leftovers = output.checked_sub(base_sum).ok_or(MathError::MathArithmetic)?;
    let mut order = [0usize, 1, 2];
    order.sort_by(|&a, &b| residues[b].cmp(&residues[a]).then_with(|| owners[a].to_bytes().cmp(&owners[b].to_bytes())));
    let positive = inputs.iter().filter(|x| **x > 0).count();
    require!((leftovers as usize) < positive, MathError::MathArithmetic);
    for index in order.into_iter().take(leftovers as usize) {
        require!(inputs[index] > 0, MathError::MathArithmetic);
        allocated[index] = allocated[index].checked_add(1).ok_or(MathError::MathArithmetic)?;
    }
    require!(allocated.iter().try_fold(0u64, |sum, value| checked_add_amount(sum, *value))? == output, MathError::MathArithmetic);
    for i in 0..3 {
        require!(allocated[i] <= MAX_AMOUNT, MathError::Amount);
        require!(inputs[i] == 0 || allocated[i] > 0, MathError::ZeroOutput);
    }
    Ok(allocated)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn owners() -> [Pubkey; 3] { [Pubkey::new_from_array([1; 32]), Pubkey::new_from_array([2; 32]), Pubkey::new_from_array([3; 32])] }

    #[test]
    fn largest_remainder_examples_and_permutation() {
        assert_eq!(largest_remainder_three(10, [1, 1, 1], owners()).unwrap(), [4, 3, 3]);
        assert_eq!(largest_remainder_three(5, [1, 2, 0], owners()).unwrap(), [2, 3, 0]);
        assert_eq!(largest_remainder_three(10, [1, 1, 1], [owners()[2], owners()[0], owners()[1]]).unwrap(), [3, 4, 3]);
        assert_eq!(largest_remainder_three(0, [0, 0, 0], owners()).unwrap(), [0; 3]);
    }

    #[test]
    fn bounds_and_nonparticipant_guards() {
        assert!(largest_remainder_three(1, [0, 0, 0], owners()).is_err());
        assert!(largest_remainder_three(1, [1, 1, 1], owners()).is_err());
        assert!(largest_remainder_three(1, [MAX_AMOUNT + 1, 0, 0], owners()).is_err());
        assert!(largest_remainder_three(1, [1, 0, 0], [owners()[0]; 3]).is_err());
        assert_eq!(largest_remainder_three(MAX_AMOUNT, [MAX_AMOUNT, 0, 0], owners()).unwrap(), [MAX_AMOUNT, 0, 0]);
        assert!(checked_add_amount(MAX_POOL_AMOUNT, 1).is_err());
    }
}
